// Action: send-eth-plain-localnode — same as send-eth-plain, but first edits
// Ethereum's RPC in the UI (Manage networks) to LOCAL_RPC, a node on the LAN.
// THROWAWAY KEY ONLY. Clones crops-warm-plain (wallet-profile already
// onboarded); here we only UNLOCK and send.
//
// DRY by default: drive to the review slip (prepare = nonce/gas/fee/chainId
// reads all fire) and stop. SEND_BROADCAST=1 in .env.crops to click Send.
// wallet: plain
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO = process.env.SEND_TO || process.env.WALLET_ADDR || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0002";
const BROADCAST = process.env.SEND_BROADCAST === "1";

(async () => {
  L.setPrefix("spl");
  const LOCAL_RPC = process.env.LOCAL_RPC || "http://192.168.68.54:8545";
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  let { ctx, extId } = await L.launch();
  log("send-eth-plain: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO);

  let page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html?view=tab`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await shot(page, "open"); await dumpTestIds(page, "open");

  // Vault key lives in storage.session, so a fresh browser is always locked.
  await fillAny(page, ["input[type=password]"], PASSWORD, "unlock-pw");
  await clickAny(page, ["role:Unlock"], "unlock");
  await page.locator("#account").waitFor({ state: "visible", timeout: 60000 });
  log("  unlock: done");
  await page.waitForTimeout(6000);   // balances (one getBalance + one multicall)
  await shot(page, "home"); await dumpTestIds(page, "home");

  // Edit the built-in Ethereum network's RPC, in the UI
  await clickAny(page, ["button[title='Manage networks']"], "manage-networks");
  await page.waitForTimeout(600);
  const rpc = page.locator("dialog[open] label", { hasText: "RPC URL" }).locator("input");
  log("  rpc before:", await rpc.inputValue());
  await rpc.fill(LOCAL_RPC);
  await shot(page, "rpc-edited");
  await clickAny(page, ['dialog[open] button:text-is("Save network")'], "save-network");
  await page.waitForTimeout(1500);
  // Restart the browser so the unlock and every read after it run with the node already set.
  await ctx.close();
  await new Promise((r) => setTimeout(r, 3000));
  log("rpc-edit: done — browser restarted; everything after this is on", LOCAL_RPC);
  ({ ctx } = await L.launch());
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html?view=tab`, { waitUntil: "load" });
  await fillAny(page, ["input[type=password]"], PASSWORD, "unlock-pw-2");
  await clickAny(page, ["role:Unlock"], "unlock-2");
  await page.locator("#account").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(5000);   // balances again, from the local node
  await shot(page, "home-local");

  await clickAny(page, ["role:Send"], "send");
  await page.waitForTimeout(800);
  await fillAny(page, ["input[placeholder='0x…']"], TO, "recipient");
  await fillAny(page, ["input[placeholder='0.0']"], AMOUNT_ETH, "amount");
  await shot(page, "form");
  await clickAny(page, ["role:Review"], "review");
  await page.getByText("Max fee").first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(1000);
  await shot(page, "review"); await dumpTestIds(page, "review");

  if (!BROADCAST) {
    log("send-eth-plain: DRY run — stopped at review, NOT broadcasting (SEND_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: dry (no broadcast)\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n`);
    await ctx.close();
    return;
  }
  await page.waitForTimeout(1000);   // Send is disabled for 800ms after render
  await clickAny(page, ['dialog[open] button.primary:text-is("Send")'], "confirm");  // the home Send sits behind the modal
  const hash = await page.locator("p.mono").first().textContent({ timeout: 30000 }).catch(() => "");
  log("  submitted:", hash);
  await page.getByText(/Confirmed|Failed|Not included/).first().waitFor({ timeout: 180000 }).catch(() => {});
  await shot(page, "done");
  fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: broadcast\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\ntxhash: ${hash}\n`);
  log("send-eth-plain: done");
  await ctx.close();
})().catch((e) => { console.error("send-eth-plain failed:", e.message || e); process.exit(1); });
