// Rabby adapter (wallet/rabby 0.94.x). Selectors from send-eth-rabby.js.
// Rabby's CSP has no connect-src, so a LAN node URL works as-is.
const L = require("../_lib");
const { log, shot, dumpTestIds } = L;

async function open(ctx, extId, { password }, tag) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 400, height: 640 });
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  const pw = page.locator("input[type=password]");
  if (await pw.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
    await pw.first().fill(password);
    await page.getByRole("button", { name: /unlock/i }).click();
    log(`  unlock (${tag}): submitted`);
  }
  await page.waitForURL(/#\/dashboard/, { timeout: 60000 });
  await page.waitForTimeout(8000);   // balances, prices, chain list
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  return page;
}

// gear → Modify RPC URL → Ethereum → URL → Save
async function setRpc(page, extId, url) {
  await page.locator("div.ml-auto > div.cursor-pointer").last().click();
  await page.waitForTimeout(1000);
  await page.getByText("Modify RPC URL").first().click();
  await page.waitForURL(/#\/custom-rpc/, { timeout: 15000 });
  await page.getByRole("button", { name: "Modify RPC URL" }).click();
  // the chain sheet slides in; a click mid-animation is lost — retry until it closes
  const search = page.locator('input[placeholder="Search chain"]');
  await search.waitFor({ timeout: 10000 });
  for (let i = 0; i < 8 && (await search.isVisible().catch(() => false)); i++) {
    await page.waitForTimeout(800);
    await page.getByText("Ethereum", { exact: true }).first().click().catch(() => {});
  }
  const input = page.locator('input[placeholder="Enter the RPC URL"]');
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill(url);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(3000);
  await shot(page, "rpc-saved");
  const listed = ((await page.textContent("body")) || "").includes(url.replace(/^https?:\/\//, ""));
  log("  custom rpc listed:", listed);
  if (!listed) throw new Error("Rabby did not save the custom RPC (see rpc-saved shot)");
}

// Send screen → recipient → (token) → amount → sign bar
async function sendForm(page, { to }, { token, amount }) {
  await page.getByText("Send", { exact: true }).first().click();
  await page.waitForURL(/#\/send-token/, { timeout: 15000 });
  await page.getByText("Select Address").click();
  await page.getByText("Enter or search address").click();
  await page.keyboard.insertText(to);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL(/to=0x/i, { timeout: 15000 });
  await page.waitForTimeout(1500);
  if (token) {
    // token chip next to the amount (shows "ETH" by default) → picker → search
    await page.getByText("ETH", { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, "token-picker"); await dumpTestIds(page, "token-picker");
    const search = page.locator('input[placeholder*="Search" i]').first();
    if (await search.isVisible().catch(() => false)) { await search.fill(token); await page.waitForTimeout(2500); }
    // tapping the row opens a token detail sheet (price chart, balance); its Confirm selects it
    await page.getByText(token, { exact: true }).first().click();
    await page.getByRole("button", { name: /^Confirm$/ }).last().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const sheet = page.locator('input[placeholder="Search Token Name / Address"]');
    if (await sheet.isVisible().catch(() => false)) throw new Error(`could not pick ${token} in the token sheet`);
    await page.waitForTimeout(1500);
    log(`  token: ${token}`);
  }
  const amt = page.locator('input[placeholder="0"]').first();
  await amt.click(); await amt.pressSequentially(amount, { delay: 60 });
  log("  amount field:", await amt.inputValue());
  await page.waitForTimeout(3000);
  await shot(page, "form");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);   // gas + pre-exec simulation
}

// Swap screen (Rabby's built-in DEX aggregator) → pick target token → amount → quote → sign bar
async function swap(page, { swapTo, swapAmount }, extId, flip = false) {
  await page.goto(`chrome-extension://${extId}/popup.html#/dex-swap?chain=ETH`, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  await shot(page, "swap-open"); await dumpTestIds(page, "swap-open");
  // "To" defaults to USDC; otherwise open its chip and search
  if (!(await page.getByText(swapTo, { exact: true }).first().isVisible().catch(() => false))) {
    await page.getByText(/^(Select Token|USDC)$/i).last().click();
    await page.waitForTimeout(1500);
    await page.locator('input[placeholder*="Search" i]').last().fill(swapTo);
    await page.waitForTimeout(3000);
    await shot(page, "swap-token-sheet"); await dumpTestIds(page, "swap-token-sheet");
    await page.getByText(swapTo, { exact: true }).last().click();
    await page.waitForTimeout(1500);
  }
  if (flip) {
    // the round arrow between From and To swaps the sides: sell the token, receive ETH
    await page.mouse.click(200, 242);
    await page.waitForTimeout(2000);
    await shot(page, "swap-flipped");
  }
  log(flip ? `  swap: ${swapTo} -> ETH` : `  swap: ETH -> ${swapTo}`);
  const amt = page.locator('input[placeholder="0"]').first();
  await amt.click(); await amt.pressSequentially(swapAmount, { delay: 60 });
  await page.waitForTimeout(12000);   // quotes from every aggregator
  await shot(page, "swap-quote"); await dumpTestIds(page, "swap-quote");
  await page.getByRole("button", { name: /^(Approve and )?Swap$/ }).last().click({ timeout: 20000 });
  await page.getByRole("button", { name: /^Confirm$/ }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);   // gas + pre-exec simulation
}

module.exports = {
  open, setRpc, swap,
  // selling a token needs an allowance first: Rabby adds the approve to the sign flow
  approveSwap: (page, a, extId) => swap(page, { ...a, swapAmount: a.approveAmount }, extId, true),
  sendEth: (page, a) => sendForm(page, a, { amount: a.amount }),
  sendToken: (page, a) => sendForm(page, a, { token: a.token, amount: a.tokenAmount }),
  // approve + swap can bring a second sign bar: keep confirming while one shows
  confirm: async (page) => {
    for (let i = 0; i < 4; i++) {
      const b = page.getByRole("button", { name: /^Confirm$/ });
      if (!(await b.first().waitFor({ timeout: i ? 15000 : 5000 }).then(() => true).catch(() => false))) break;
      await b.first().click(); log(`  confirm ${i + 1}: clicked`);
      await page.waitForTimeout(6000); await shot(page, `after-confirm-${i + 1}`);
    }
  },
};
