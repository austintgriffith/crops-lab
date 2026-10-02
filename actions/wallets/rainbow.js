// Rainbow adapter (wallet/rainbow 1.6.x). Selectors from send-eth-rainbow*.js.
const http = require("http");
const L = require("../_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

async function open(ctx, extId, { password }, tag) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  // wait for the lock screen to mount so a slow boot can't skip it
  const locked = await page.locator('[data-testid="password-input"]').first()
    .waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  if (locked) {
    await fillAny(page, ["password-input"], password, "unlock-pw");
    await clickAny(page, ["unlock-button", "role:Unlock", "role:Continue"], "unlock", { optional: true, timeout: 5000 })
      || await page.keyboard.press("Enter");
    log(`  unlock (${tag}): submitted`);
  }
  await page.waitForTimeout(10000);   // chains, prices, balances, config
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  return page;
}

// Rainbow's CSP (connect-src) only allows http://127.0.0.1:* — a LAN URL is
// blocked before it leaves the browser. Run a forwarder on 127.0.0.1:8545 that
// relays to the LAN node through the lab proxy, so the node calls stay captured.
function prepNode(nodeUrl) {
  const u = new URL(nodeUrl);
  http.createServer((req, res) => {
    const up = http.request({ host: process.env.HOST_PROXY, port: process.env.PROXY_PORT, method: req.method,
      path: nodeUrl.replace(/\/$/, "") + req.url, headers: { ...req.headers, host: u.host } }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, "access-control-allow-origin": "*" }); r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  }).listen(8545, "127.0.0.1");
  process.env.PROXY_BYPASS = "127.0.0.1";   // browser → forwarder directly; forwarder → proxy → node
  log("forwarder: 127.0.0.1:8545 ->", nodeUrl, "via lab proxy");
  return "http://127.0.0.1:8545";
}

async function setRpc(page, extId, url) {
  await page.goto(`chrome-extension://${extId}/popup.html#/settings/networks`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await clickAny(page, ["text:Ethereum"], "eth-network");
  await page.waitForTimeout(1500);
  await clickAny(page, ["custom-rpc-button", "text:Add RPC"], "add-rpc");
  await page.waitForTimeout(1500);
  await fillAny(page, ["custom-network-rpc-url"], url, "rpc-url", { type: true });
  await fillAny(page, ["network-name-field"], "Local node", "rpc-name", { optional: true, timeout: 3000 });
  await page.waitForTimeout(3000);   // Rainbow probes the URL's chain id
  await clickAny(page, ["add-rpc-button"], "add-rpc-submit", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot(page, "rpc-added");
}

async function sendForm(page, { to }, { asset, amount }) {
  await clickAny(page, ["header-link-send", "role:Send", "text:Send"], "send");
  await page.waitForTimeout(1500);
  await fillAny(page, ["to-address-input", "input[placeholder*='address' i]", "input[placeholder*='ENS' i]"], to, "recipient", { type: true });
  await page.waitForTimeout(2000);   // address lookup fires here
  await clickAny(page, ["token-input", "text:Select token", "text:Choose token"], "open-token-picker", { optional: true, timeout: 4000 });
  await page.waitForTimeout(1000);
  await shot(page, "token-picker"); await dumpTestIds(page, "token-picker");
  await clickAny(page, asset, "pick-asset", { optional: asset[0] === "text:Ethereum", timeout: 6000 });
  await page.waitForTimeout(1500);
  await fillAny(page, ["send-input-mask", "input[inputmode='decimal']", "input[placeholder='0']", "input[placeholder*='0.']"], amount, "amount", { type: true });
  await page.waitForTimeout(2000);   // gas estimate
  await shot(page, "form");
  await clickAny(page, ["send-review-button", "role:Review", "role:Continue"], "review");
  await page.waitForTimeout(3500);   // review sheet: simulation / fee data
}

// Swap: header Swap → pick target token → amount → review
async function swap(page, { swapTo, swapAmount }, extId, flip = false) {
  await clickAny(page, ["header-link-swap", "role:Swap", "text:Swap"], "swap");
  await page.waitForTimeout(3000);
  await shot(page, "swap-open"); await dumpTestIds(page, "swap-open");
  // the sell side defaults to ETH; open the buy-side picker
  await clickAny(page, ["token-to-buy-search-token-input", "token-to-buy-dropdown-token-input-field", "text:Receive", "text:Select token"], "buy-picker");
  await page.waitForTimeout(1500);
  await fillAny(page, ["token-to-buy-search-token-input", "input[placeholder*='Search' i]"], swapTo, "buy-search", { type: true });
  await page.waitForTimeout(3000);
  await shot(page, "swap-token-sheet"); await dumpTestIds(page, "swap-token-sheet");
  await clickAny(page, [`text:${swapTo}`], "pick-buy");
  await page.waitForTimeout(1500);
  if (flip) { await clickAny(page, ["swap-flip-button"], "flip"); await page.waitForTimeout(2000); }
  // the sell side arrives prefilled with your max balance — clear it, then type
  const sell = page.locator("[data-testid$='token-to-sell-swap-token-input-swap-input-mask']").first();
  await sell.click();
  await page.keyboard.press("Meta+A"); await page.keyboard.press("Backspace");
  await sell.pressSequentially(swapAmount, { delay: 60 });
  log("  sell amount:", await sell.inputValue());
  await page.waitForTimeout(10000);   // quote
  await shot(page, "swap-quote"); await dumpTestIds(page, "swap-quote");
  await clickAny(page, ["swap-confirmation-button-ready", "swap-confirmation-button", "role:Review", "text:Review"], "swap-review", { timeout: 20000 });
  await page.waitForTimeout(4000);
}

module.exports = {
  open, setRpc, prepNode, swap,
  approveSwap: (page, a, extId) => swap(page, { ...a, swapAmount: a.approveAmount }, extId, true),
  sendEth: (page, a) => sendForm(page, a, { asset: ["text:Ethereum", "text:ETH"], amount: a.amount }),
  sendToken: (page, a) => sendForm(page, a, { asset: [`text:${a.token}`], amount: a.tokenAmount }),
  confirm: (page) => clickAny(page, ["review-confirm-button", "swap-review-execute", "role:Send", "role:Confirm"], "confirm"),
};
