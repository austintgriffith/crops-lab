// Action: send-eth-rabby — self-send 0.0002 ETH from Rabby (wallet/rabby
// 0.94.6). THROWAWAY KEY ONLY. Clones crops-warm-rabby (wallet-profile
// already onboarded); here we only UNLOCK and send.
//
// With LOCAL_RPC set (see send-eth-rabby-localnode), first points Ethereum at
// that node through Rabby's own UI (gear → Modify RPC URL → Ethereum → URL →
// Save), restarts the browser, logs 'rpc-edit: done', then sends — so the
// capture shows what goes to your node vs what still leaves.
//
// DRY by default: Send → Rabby shows the sign bar (gas, pre-exec simulation
// fire) and we stop. SEND_BROADCAST=1 in .env.crops to click Confirm.
// wallet: rabby
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const { log, shot, dumpTestIds } = L;

const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO = process.env.SEND_TO || process.env.WALLET_ADDR || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0002";
const BROADCAST = process.env.SEND_BROADCAST === "1";
const LOCAL_RPC = process.env.LOCAL_RPC || "";

(async () => {
  L.setPrefix(LOCAL_RPC ? "srbl" : "srb");
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  let { ctx, extId } = await L.launch();
  log("send-eth-rabby: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO, LOCAL_RPC ? `(node ${LOCAL_RPC})` : "");

  let page;
  const open = async (tag) => {
    page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 640 });
    await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
    const pw = page.locator("input[type=password]");
    if (await pw.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
      await pw.first().fill(PASSWORD);
      await page.getByRole("button", { name: /unlock/i }).click();
      log(`  unlock (${tag}): submitted`);
    }
    await page.waitForURL(/#\/dashboard/, { timeout: 60000 });
    await page.waitForTimeout(8000);   // balances, prices, chain list
    await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  };
  await open("start");

  if (LOCAL_RPC) {
    // gear (last icon top-right) → Settings panel → Modify RPC URL
    await page.locator("div.ml-auto > div.cursor-pointer").last().click();
    await page.waitForTimeout(1000);
    await shot(page, "settings");
    await page.getByText("Modify RPC URL").first().click();
    await page.waitForURL(/#\/custom-rpc/, { timeout: 15000 });
    await page.getByRole("button", { name: "Modify RPC URL" }).click();
    await page.waitForTimeout(1000);
    await page.getByText("Ethereum", { exact: true }).first().click();
    const url = page.locator('input[placeholder="Enter the RPC URL"]');
    await url.waitFor({ timeout: 10000 });
    await url.fill(LOCAL_RPC);
    await shot(page, "rpc-edited");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(3000);
    await shot(page, "rpc-saved");
    const listed = ((await page.textContent("body")) || "").includes(LOCAL_RPC.replace(/^https?:\/\//, ""));
    log("  custom rpc listed:", listed);
    if (!listed) throw new Error("Rabby did not save the custom RPC (see rpc-saved shot)");
    // Restart so the unlock and every read after it run with the node already set.
    await ctx.close();
    await new Promise((r) => setTimeout(r, 3000));
    log("rpc-edit: done — browser restarted; everything after this is on", LOCAL_RPC);
    ({ ctx } = await L.launch());
    await open("local");
  }

  await page.getByText("Send", { exact: true }).first().click();
  await page.waitForURL(/#\/send-token/, { timeout: 15000 });
  await page.getByText("Select Address").click();
  await page.getByText("Enter or search address").click();
  await page.keyboard.insertText(TO);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL(/to=0x/i, { timeout: 15000 });
  const amt = page.locator('input[placeholder="0"]').first();
  await page.waitForTimeout(1500);
  await amt.click(); await amt.pressSequentially(AMOUNT_ETH, { delay: 60 });
  log("  amount field:", await amt.inputValue());
  await page.waitForTimeout(3000);
  await shot(page, "form");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);   // gas + pre-exec
  await shot(page, "review"); await dumpTestIds(page, "review");

  if (!BROADCAST) {
    log("send-eth-rabby: DRY run — stopped at the sign bar, NOT broadcasting (SEND_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: dry (no broadcast)\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\nnode: ${LOCAL_RPC || "rabby default"}\n`);
    await ctx.close();
    return;
  }
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForTimeout(15000);
  await shot(page, "after-confirm"); await dumpTestIds(page, "after-confirm");
  await page.goto(`chrome-extension://${extId}/popup.html#/history`).catch(() => {});
  await page.waitForTimeout(5000);
  await shot(page, "history");
  fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: broadcast\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\nnode: ${LOCAL_RPC || "rabby default"}\n`);
  log("send-eth-rabby: done");
  await ctx.close();
})().catch((e) => { console.error("send-eth-rabby failed:", e.message || e); process.exit(1); });
