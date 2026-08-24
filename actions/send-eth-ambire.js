// Action: send-eth-ambire — Ambire Web3 Wallet, mainnet, send a tiny amount of
// ETH with default settings while the host captures every byte. THROWAWAY KEY
// ONLY. Clones crops-warm-ambire; here we only UNLOCK and send.
//
// Ambire is a smart account: the interesting leg is the RELAYER / BUNDLER, not
// an eth_sendRawTransaction. DRY by default — drive to the sign screen (where
// the estimate/simulation/relayer-quote traffic fires) and stop.
// SEND_BROADCAST=1 in .env.crops to actually sign+submit.
// wallet: ambire
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO = process.env.SEND_TO || process.env.WALLET_ADDR || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0002";
const BROADCAST = process.env.SEND_BROADCAST === "1";

(async () => {
  L.setPrefix("sae");
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  const { ctx, extId } = await L.launch();
  log("send-eth-ambire: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/tab.html`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid]").length > 0, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, "open"); await dumpTestIds(page, "open");

  // Unlock (keystore password)
  if (await page.locator('[data-testid="passphrase-field"], [data-testid="enter-pass-field"], [data-testid="input-passphrase"]').first().isVisible().catch(() => false)) {
    await fillAny(page, ["passphrase-field", "enter-pass-field", "input-passphrase"], PASSWORD, "unlock-pw");
    await clickAny(page, ["button-unlock", "text:Unlock"], "unlock", { optional: true, timeout: 5000 }) || await page.keyboard.press("Enter");
    log("  unlock: submitted");
    await page.waitForTimeout(3000);
  }
  // Settle: portfolio load, prices, account state (relayer, invictus, cena…)
  await page.waitForTimeout(9000);
  await shot(page, "dashboard"); await dumpTestIds(page, "dashboard");

  // Send
  await clickAny(page, ["dashboard-button-send", "token-send", "text:Send"], "send");
  await page.waitForTimeout(2000);
  await shot(page, "send-form"); await dumpTestIds(page, "send-form");

  // Recipient
  await fillAny(page, ["address", "add-safe-address-field", "input[placeholder*='address' i]", "input[placeholder*='ENS' i]"], TO, "recipient", { type: true });
  await page.waitForTimeout(2500);   // address resolution / screening fires
  await shot(page, "recipient");

  // Amount (no dedicated testid; the send-form numeric input)
  await fillAny(page, ["amount-field", "input[inputmode='decimal']", "input[placeholder='0']", "input[type='number']", "input[placeholder*='0.' i]"], AMOUNT_ETH, "amount", { type: true, optional: true, timeout: 8000 });
  await page.waitForTimeout(2500);   // estimate / relayer quote
  await shot(page, "amount"); await dumpTestIds(page, "amount");

  // Proceed to sign
  await clickAny(page, ["send-form-proceed", "proceed-btn", "token-send", "text:Send", "text:Continue", "text:Review"], "proceed");
  await page.waitForTimeout(4000);   // sign screen: gas/paymaster/simulation
  await shot(page, "sign-screen"); await dumpTestIds(page, "sign-screen");

  if (!BROADCAST) {
    log("send-eth-ambire: DRY run — stopped at sign screen, NOT broadcasting (SEND_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: dry (no broadcast)\nwallet: ambire\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n`);
    await page.waitForTimeout(2000);
    await ctx.close();
    return;
  }
  await clickAny(page, ["sign-button", "button-sign", "sign-proceed-btn", "transaction-button-sign", "text:Sign"], "sign");
  log("  sign: clicked");
  await page.waitForTimeout(20000);  // relayer/bundler submit + first status polls
  await shot(page, "after-sign"); await dumpTestIds(page, "after-sign");
  fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: broadcast\nwallet: ambire\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n(userOp/tx: see flows.jsonl relayer.ambire.com / bundler)\n`);
  await page.waitForTimeout(20000);  // confirmation polling
  await shot(page, "done");
  log("send-eth-ambire: submitted");
  await ctx.close();
})().catch((e) => { console.error("send-eth-ambire failed:", e.message || e); process.exit(1); });
