// Coinbase Wallet adapter (wallet/coinbase 3.148.x). Selectors from host probes, Oct 2.
const L = require("../_lib");
const { log, shot, dumpTestIds } = L;

async function open(ctx, extId, { password }, tag) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/index.html#/`, { waitUntil: "load" });
  const pw = page.locator("input[type=password]");
  // lock screen or portfolio — whichever mounts first
  await pw.or(page.getByTestId("wallet-balance")).first().waitFor({ timeout: 30000 }).catch(() => {});
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(password); await page.keyboard.press("Enter");
    log(`  unlock (${tag}): submitted`);
  }
  await page.getByTestId("wallet-balance").waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);   // balances, prices, config
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  return page;
}

// Send: amount screen (USD by default — flip to the token) → recipient → confirm screen
async function sendForm(page, { to }, { token, amount }) {
  await page.getByTestId("portfolio-menu-send-button").click();
  await page.getByTestId("send-wrapper").waitFor({ timeout: 15000 });
  if (token) {
    await page.getByTestId("send-asset-selector").click();
    await page.waitForTimeout(2000);
    await shot(page, "token-picker"); await dumpTestIds(page, "token-picker");
    await page.locator(`[data-testid="send-asset-item-ETHEREUM_CHAIN:1/false-${token.toUpperCase()}-cell-pressable"]`).click();
    await page.waitForTimeout(2000);
    log(`  token: ${token}`);
  }
  await page.getByTestId("flip-asset-btn").click();
  await page.waitForTimeout(800);
  const amt = page.getByTestId("currency-input");
  await amt.click(); await amt.pressSequentially(amount, { delay: 100 });
  log("  amount field:", await amt.inputValue());
  await page.waitForTimeout(1500);
  await shot(page, "amount");
  await page.getByTestId("send-entry-button").click();
  const addr = page.getByTestId("address-textarea").locator("textarea").or(page.locator("textarea")).first();
  await addr.fill(to, { timeout: 15000 });
  await page.waitForTimeout(3000);   // address lookups fire here
  await page.getByTestId("suggestion-item").first().click();
  await page.getByTestId("send-confirm-button").waitFor({ timeout: 30000 });
  await page.waitForTimeout(4000);   // fee quote
}

// Swap: Swap → (first-run intro) → From/To pickers → amount in token units → "Find the best price" → preview
async function swap(page, { from, to, amount }) {
  await page.getByTestId("portfolio-menu-swap-button").click();
  await page.getByTestId("swap-nux-swap-button").click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId("dex-to-selector").waitFor({ timeout: 15000 });
  await shot(page, "swap-open"); await dumpTestIds(page, "swap-open");
  if (from !== "ETH") {
    await page.getByTestId("dex-from-selector").click();
    await page.locator(`[data-testid$="false-${from}-cell-pressable"]`).first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
  }
  await page.getByTestId("dex-to-selector").click();
  await page.getByTestId("search-asset-text-input").locator("input").or(page.locator('input[placeholder="Search"]')).first().fill(to);
  await page.waitForTimeout(3000); await dumpTestIds(page, "swap-to-picker");
  await page.locator(`[data-testid^="dex-to-asset-item-ETHEREUM_CHAIN:1/"][data-testid$="-${to}-cell-pressable"]`).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.getByTestId("flip-asset-btn").click();   // dollars → token units
  await page.waitForTimeout(800);
  const amt = page.getByTestId("currency-input");
  await amt.click(); await amt.pressSequentially(amount, { delay: 100 });
  log(`  swap: ${amount} ${from} -> ${to}`);
  await page.waitForTimeout(1500);
  await shot(page, "swap-form");
  await page.getByTestId("dex-entry-preview-button").click();
  await page.waitForTimeout(12000);   // quotes from the DEX aggregator
  await shot(page, "swap-quote"); await dumpTestIds(page, "swap-quote");
}

module.exports = {
  open,
  swap: (page, a) => swap(page, { from: "ETH", to: a.swapTo, amount: a.swapAmount }),
  approveSwap: (page, a) => swap(page, { from: a.swapTo, to: "ETH", amount: a.approveAmount }),
  sendEth: (page, a) => sendForm(page, a, { amount: a.amount }),
  sendToken: (page, a) => sendForm(page, a, { token: a.token, amount: a.tokenAmount }),
  // Send asks for the password again before it signs; after unlock the confirm screen may need Send once more
  // sends end in send-confirm-button, swaps in "Swap"; either asks for the password again before signing
  confirm: async (page, { password }) => {
    const go = async () => {
      const swapBtn = page.getByRole("button", { name: "Swap", exact: true }).filter({ visible: true });
      if (await swapBtn.count()) { await swapBtn.first().click(); return true; }
      if (await page.getByTestId("send-confirm-button").isVisible().catch(() => false)) { await page.getByTestId("send-confirm-button").click(); return true; }
      return false;
    };
    await go();
    // the lock form sits under the app layer: fill without clicking, submit by force
    const pw = page.locator('input[data-testid="unlock-with-password"]').last();
    if (await pw.waitFor({ state: "attached", timeout: 8000 }).then(() => true).catch(() => false)) {
      await pw.fill(password);
      await page.getByTestId("unlock-wallet-button").last().click({ force: true });
      log("  re-auth: password entered");
      await page.waitForTimeout(4000);
      await shot(page, "after-reauth");
      if (await go()) log("  confirm: clicked again after re-auth");
    }
  },

};
