// Phantom adapter (wallet/phantom 26.x). Selectors from host probes, Oct 2.
// Phantom keeps earlier routes mounted, so most lookups target the visible copy.
const L = require("../_lib");
const { log, shot, dumpTestIds } = L;

async function open(ctx, extId, { password }, tag) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  const pw = page.locator("input[type=password]");
  await pw.or(page.getByTestId("portfolio-balance")).first().waitFor({ timeout: 30000 }).catch(() => {});
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(password); await page.getByRole("button", { name: "Unlock" }).click();
    log(`  unlock (${tag}): submitted`);
  }
  await page.getByTestId("portfolio-balance").waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);
  // one-time promo sheets
  for (let i = 0; i < 3; i++) await page.getByTestId("interstitial-primary-button").click({ timeout: 1500 }).catch(() => {});
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  return page;
}

// Send → token picker → recipient + amount → Next → confirm screen
async function sendForm(page, { to }, { tokenRow, amount }) {
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, "token-picker");
  // the picker sheet lists the same rows as home; its copy is the visible last one
  await page.getByText(tokenRow, { exact: true }).filter({ visible: true }).last().click();
  await page.waitForTimeout(2000);
  await page.locator('textarea[placeholder*="Recipient"]').fill(to);
  await page.waitForTimeout(1500);   // address lookups
  await page.locator('input[placeholder="Amount"]').fill(amount);
  await page.waitForTimeout(1500);
  await shot(page, "form");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).last().waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);   // fee + simulation
}

// Swap tab opens on Solana (SOL → USDC): pick the pay token from your holdings,
// search the receive token (the picker defaults its chain filter to Ethereum once ETH pays)
async function swap(page, { payRow, buy, amount }) {
  await page.getByTestId("bottom-tab-nav-button-/swap").click();
  await page.getByTestId("sell-token-button").waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot(page, "swap-open"); await dumpTestIds(page, "swap-open");
  await page.getByTestId("sell-token-button").click();
  await page.waitForTimeout(1500);
  await page.getByText(payRow, { exact: true }).filter({ visible: true }).last().click();
  await page.waitForTimeout(2000);
  await page.getByTestId("buy-token-button").click();
  await page.waitForTimeout(1500);
  await page.locator('input[placeholder="Search..."]').last().fill(buy);
  await page.waitForTimeout(3000);
  await shot(page, "swap-buy-picker"); await dumpTestIds(page, "swap-buy-picker");
  // first result under the Ethereum chain filter
  // text matches also hit the swap screen under the sheet; the top result row sits at a fixed spot
  await page.mouse.click(300, 225);
  await page.waitForTimeout(2000);
  const pay = page.locator('[data-testid="tab-content-/swap"] input').first();
  await pay.click(); await pay.pressSequentially(amount, { delay: 80 });
  log(`  swap: ${amount} ${payRow} -> ${buy}`);
  // quote, fee, slippage — the button enables once a quote is in
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Swap Now" && !b.disabled && b.getBoundingClientRect().width > 0), null, { timeout: 45000 });
  await page.waitForTimeout(3000);
  await shot(page, "swap-quote"); await dumpTestIds(page, "swap-quote");
}

module.exports = {
  open,
  swap: (page, a) => swap(page, { payRow: "Ethereum", buy: a.swapTo, amount: a.swapAmount }),
  approveSwap: (page, a) => swap(page, { payRow: a.swapTo, buy: "ETH", amount: a.approveAmount }),
  sendEth: (page, a) => sendForm(page, a, { tokenRow: "Ethereum", amount: a.amount }),
  sendToken: (page, a) => sendForm(page, a, { tokenRow: a.tokenName || "MetaMask USD (Test)", amount: a.tokenAmount }),
  // send screens end in "Send", swaps in "Swap Now"
  confirm: async (page) => {
    const swapNow = page.getByRole("button", { name: "Swap Now" }).filter({ visible: true });
    if (await swapNow.count()) { await swapNow.first().click(); log("  confirm: Swap Now"); }
    else await page.getByRole("button", { name: "Send", exact: true }).last().click();
    await page.waitForTimeout(3000);
    // a confirmation sheet may follow
    const again = page.getByRole("button", { name: /^(Confirm|Swap|Approve)$/ }).filter({ visible: true });
    if (await again.count()) { await again.first().click(); log("  confirm: sheet confirmed"); }
  },
};
