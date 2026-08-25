// Action: send-eth-rainbow — Rainbow extension, mainnet, send a tiny amount
// of ETH with default settings while the host captures every byte.
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
  L.setPrefix("sre");
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  const { ctx, extId } = await L.launch();
  log("send-eth-rainbow: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" }).catch(async () => {
    await page.goto(`chrome-extension://${extId}/index.html`, { waitUntil: "load" });
  });
  await page.waitForTimeout(2000);
  await shot(page, "open"); await dumpTestIds(page, "open");

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
})().catch((e) => { console.error("send-eth-rainbow failed:", e.message || e); process.exit(1); });
