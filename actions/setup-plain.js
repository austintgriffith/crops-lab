// Action: setup-plain — onboard Plain Wallet (wallet/plain, 0.1.8, built from
// backmeupplz/plainwallet source) once by importing the throwaway mnemonic, so
// the VM can be snapshotted as crops-warm-plain. NOT a capture run. Same key as
// the other warm images → same address → comparable send.
//
// Flow (no testids; plain DOM, button text is stable):
//   "Enter seed phrase or private key" -> textarea -> 2 password inputs
//   -> "Import wallet" -> home (account select #account)
// wallet: plain
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

(async () => {
  L.setPrefix("sp");
  if (MNEMONIC.split(" ").filter(Boolean).length < 12) { console.error("WALLET_MNEMONIC missing/short"); process.exit(2); }
  if (PASSWORD.length < 12) { console.error("WALLET_PASSWORD missing or < 12 chars (Plain Wallet minimum)"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true, proxy: false });
  log("setup-plain: extension id", extId);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html?view=tab`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForTimeout(2000);
  await shot(page, "entry"); await dumpTestIds(page, "entry");

  await clickAny(page, ["role:Enter seed phrase or private key"], "import-mode");
  await page.waitForTimeout(800);
  await fillAny(page, ["label > textarea"], MNEMONIC, "seed");
  const pws = page.locator("input[type=password]");
  await pws.nth(0).fill(PASSWORD);
  await pws.nth(1).fill(PASSWORD);
  log("  fill passwords: 2 inputs");
  await shot(page, "filled");
  await clickAny(page, ["role:Import wallet"], "import");
  // scrypt N=2^17 (128 MiB) runs in the page: give it time
  await page.locator("#account").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(4000);   // first balance read
  await shot(page, "home"); await dumpTestIds(page, "home");
  const title = (await page.locator("#account").getAttribute("title").catch(() => "")) || "";
  log(`setup-plain: account ${title} ${title.toLowerCase() === ADDR ? "== WALLET_ADDR" : `(expected ${ADDR})`}`);
  if (ADDR && title.toLowerCase() !== ADDR) throw new Error("imported address does not match WALLET_ADDR");
  log("setup-plain: done — profile at", L.PROFILE);
  await ctx.close();
})().catch((e) => { console.error("setup-plain failed:", e.message || e); process.exit(1); });
