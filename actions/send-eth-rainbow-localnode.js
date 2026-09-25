// Action: send-eth-rainbow-localnode — send-eth-rainbow, but FIRST point
// Rainbow's Ethereum network at LOCAL_RPC (a LAN node) through its own UI,
// restart the browser, then send. Proves what goes to your node vs out.
// THROWAWAY KEY ONLY. Clones crops-warm-rainbow (wallet-profile already
// onboarded); here we only UNLOCK and send.
//
// DRY by default: drive to the review sheet (gas, simulation fire) and stop.
// SEND_BROADCAST=1 in .env.crops to actually confirm.
// wallet: rainbow
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO = process.env.SEND_TO || process.env.WALLET_ADDR || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0002";
const BROADCAST = process.env.SEND_BROADCAST === "1";

(async () => {
  L.setPrefix("srl");
  const NODE = process.env.LOCAL_NODE || "http://192.168.68.54:8545";
  // Rainbow's extension CSP (connect-src) only allows http://127.0.0.1:* — a LAN
  // URL is blocked before it leaves the browser. So: your node on YOUR computer.
  // A forwarder on 127.0.0.1:8545 relays to the LAN node through the lab proxy,
  // so every call Rainbow makes to "your node" still lands in the capture.
  const LOCAL_RPC = "http://127.0.0.1:8545";
  const http = require("http");
  const nodeUrl = new URL(NODE);
  http.createServer((req, res) => {
    const up = http.request({ host: process.env.HOST_PROXY, port: process.env.PROXY_PORT, method: req.method,
      path: NODE + req.url.replace(/^\//, ""), headers: { ...req.headers, host: nodeUrl.host } }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, "access-control-allow-origin": "*" }); r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  }).listen(8545, "127.0.0.1");
  process.env.PROXY_BYPASS = "127.0.0.1";   // browser → forwarder directly; forwarder → proxy → node
  log("forwarder: 127.0.0.1:8545 ->", NODE, "via lab proxy");
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  let { ctx, extId } = await L.launch();
  log("send-eth-rainbow: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO);

  let page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" }).catch(async () => {
    await page.goto(`chrome-extension://${extId}/index.html`, { waitUntil: "load" });
  });
  await page.waitForTimeout(2000);
  await shot(page, "open"); await dumpTestIds(page, "open");

  const unlock = async () => {
  // Unlock — wait for the lock screen to mount so a slow boot can't skip it.
    const locked = await page.locator('[data-testid="password-input"]').first()
      .waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
    if (locked) {
      await fillAny(page, ["password-input"], PASSWORD, "unlock-pw");
      await clickAny(page, ["unlock-button", "role:Unlock", "role:Continue"], "unlock", { optional: true, timeout: 5000 })
        || await page.keyboard.press("Enter");
      log("  unlock: submitted");
      await page.waitForTimeout(2500);
    }
  };
  await unlock();
  // ---- point Ethereum at the LAN node, in Rainbow's UI ----
  log("rpc-edit: start ->", LOCAL_RPC);
  await page.goto(`chrome-extension://${extId}/popup.html#/settings/networks`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await shot(page, "rpc-networks"); await dumpTestIds(page, "rpc-networks");
  await clickAny(page, ["text:Ethereum"], "eth-network");
  await page.waitForTimeout(1500);
  await shot(page, "rpc-eth"); await dumpTestIds(page, "rpc-eth");
  await clickAny(page, ["custom-rpc-button", "text:Add RPC"], "add-rpc");
  await page.waitForTimeout(1500);
  await shot(page, "rpc-form"); await dumpTestIds(page, "rpc-form");
  await fillAny(page, ["custom-network-rpc-url"], LOCAL_RPC, "rpc-url", { type: true });
  await fillAny(page, ["network-name-field"], "Local node", "rpc-name", { optional: true, timeout: 3000 });
  await page.waitForTimeout(3000);   // Rainbow probes the URL's chain id
  await shot(page, "rpc-filled"); await dumpTestIds(page, "rpc-filled");
  await clickAny(page, ["add-rpc-button"], "add-rpc-submit", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot(page, "rpc-added"); await dumpTestIds(page, "rpc-added");
  // Restart the browser so startup calls also run with the node set.
  await ctx.close();
  await new Promise((r) => setTimeout(r, 3000));
  log("rpc-edit: done — browser restarted; everything after this is on", LOCAL_RPC);
  ({ ctx } = await L.launch());
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await unlock();
  // Let the wallet settle: background calls (chains, prices, balances, config)
  await page.waitForTimeout(8000);
  await shot(page, "home"); await dumpTestIds(page, "home");

  // Send
  await clickAny(page, ["header-link-send", "role:Send", "text:Send"], "send");
  await page.waitForTimeout(1500);
  await shot(page, "send-to"); await dumpTestIds(page, "send-to");
  await fillAny(page, ["to-address-input", "input[placeholder*='address' i]", "input[placeholder*='ENS' i]"], TO, "recipient", { type: true });
  await page.waitForTimeout(2000);   // address resolution / lookup fires here
  await shot(page, "recipient-entered");

  // Asset: pick ETH if a token picker is shown
  await clickAny(page, ["token-input", "text:Select token", "text:Choose token"], "open-token-picker", { optional: true, timeout: 4000 });
  await page.waitForTimeout(1000);
  await clickAny(page, ["text:Ethereum", "text:ETH"], "pick-eth", { optional: true, timeout: 6000 });
  await page.waitForTimeout(1500);
  await shot(page, "asset"); await dumpTestIds(page, "asset");

  // Amount
  await fillAny(page, ["send-input-mask", "input[inputmode='decimal']", "input[placeholder='0']", "input[placeholder*='0.']"], AMOUNT_ETH, "amount", { type: true });
  await page.waitForTimeout(2000);   // gas estimate fires
  await shot(page, "amount");

  // Review
  await clickAny(page, ["send-review-button", "role:Review", "role:Continue"], "review");
  await page.waitForTimeout(3500);   // review sheet: simulation / fee data
  await shot(page, "review"); await dumpTestIds(page, "review");

  if (!BROADCAST) {
    log("send-eth-rainbow: DRY run — stopped at review, NOT broadcasting (SEND_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: dry (no broadcast)\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n`);
    await page.waitForTimeout(2000);
    await ctx.close();
    return;
  }
  await clickAny(page, ["review-confirm-button", "role:Send", "role:Confirm"], "confirm");
  log("  confirm: clicked");
  await page.waitForTimeout(15000);  // broadcast + first status polls
  await shot(page, "after-confirm"); await dumpTestIds(page, "after-confirm");
  fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: broadcast\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n(txhash: see flows.jsonl eth_sendRawTransaction)\n`);
  await page.waitForTimeout(20000);  // confirmation polling
  await shot(page, "done");
  log("send-eth-rainbow: submitted");
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("send-eth-rainbow failed:", e.message || e); process.exit(1); });
