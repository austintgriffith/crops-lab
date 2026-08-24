// Action: setup-rainbow — onboard the Rainbow extension (wallet/rainbow,
// 1.6.11) once by importing the throwaway mnemonic, so the VM can be
// snapshotted as crops-warm-rainbow. NOT a capture run. Same key as the
// MetaMask warm image → same address → same send, two wallets, comparable.
//
// Flow (selectors = data-testids from the built bundle):
//   welcome -> import-wallet-button -> import-via-seed-option
//   -> seed words (paste into first input; fallback: type per input)
//   -> import-wallet-button / add-wallets-button
//   -> new-password-input + confirm-new-password-input -> set-password-button
//   -> skip/continue gauntlet -> home
// wallet: rainbow
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

(async () => {
  L.setPrefix("sr");
  if (MNEMONIC.split(" ").filter(Boolean).length < 12) { console.error("WALLET_MNEMONIC missing/short"); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true, proxy: false });
  log("setup-rainbow: extension id", extId);

  let page = ctx.pages().find((p) => p.url().includes(extId));
  if (!page) { page = await ctx.newPage(); }
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" }).catch(async () => {
    await page.goto(`chrome-extension://${extId}/index.html`, { waitUntil: "load" });
  });
  await page.bringToFront();
  await page.waitForTimeout(3000);
  await shot(page, "entry"); await dumpTestIds(page, "entry");

  // 1. Import path
  await clickAny(page, ["import-wallet-button", "import-wallet-option", "text:Import"], "import-mode");
  await page.waitForTimeout(1000);
  await shot(page, "import-options");
  await clickAny(page, ["import-wallet-option"], "restore-option", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1000);
  await shot(page, "import-kind"); await dumpTestIds(page, "import-kind");
  await clickAny(page, ["import-via-seed-option"], "via-seed", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1000);
  await shot(page, "seed-form"); await dumpTestIds(page, "seed-form");

  // 2. Seed words. Rainbow splits a pasted phrase across its word inputs.
  const words = MNEMONIC.split(" ");
  const inputs = page.locator("input[type=password], input[type=text], textarea");
  const n = await inputs.count();
  log(`  seed form: ${n} inputs`);
  try { execSync("pbcopy", { input: MNEMONIC }); } catch (e) { log("  pbcopy failed:", e.message); }
  await inputs.first().click();
  await page.keyboard.press("Meta+V");
  await page.waitForTimeout(800);
  let filled = 0;
  for (let i = 0; i < Math.min(n, 24); i++) { const v = await inputs.nth(i).inputValue().catch(() => ""); if (v.trim()) filled++; }
  if (filled < 12 && n >= 12) {
    log("  paste didn't spread; typing per input");
    for (let i = 0; i < words.length; i++) { await inputs.nth(i).fill(words[i]); }
  } else if (filled < 12 && n < 12) {
    log("  single field; filling whole phrase");
    await inputs.first().fill(MNEMONIC);
  }
  await shot(page, "seed-filled");
  await clickAny(page, ["import-wallet-button", "import-wallets-button", "continue-button", "role:Import Wallet", "role:Continue"], "seed-continue");
  await page.waitForTimeout(2500);
  await shot(page, "after-seed"); await dumpTestIds(page, "after-seed");

  // 3. Wallet picker (which derived accounts to add), if shown
  await clickAny(page, ["add-wallets-button", "import-wallets-button", "role:Add Wallets", "role:Continue"], "add-wallets", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1500);
  await shot(page, "password");

  // 4. Password
  await fillAny(page, ["new-password-input", "password-input"], PASSWORD, "pw-new");
  await fillAny(page, ["confirm-new-password-input", "confirm-password-input"], PASSWORD, "pw-confirm");
  await clickAny(page, ["set-password-button", "role:Set Password", "role:Continue"], "pw-submit");
  await page.waitForTimeout(3000);
  await shot(page, "post-password"); await dumpTestIds(page, "post-password");

  // 5. Gauntlet
  const advance = ["skip-button", "skip-this-button", "continue-button", "role:Skip", "role:Continue", "role:Done", "role:Got it", "role:Not now", "role:Maybe later"];
  for (let i = 0; i < 6; i++) {
    const c = await clickAny(page, advance, `advance-${i}`, { optional: true, timeout: 5000 });
    if (!c) break;
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(2500);
  await shot(page, "home"); await dumpTestIds(page, "home");
  if (ADDR) {
    const seen = await page.getByText(ADDR.slice(2, 6), { exact: false }).first().isVisible().catch(() => false);
    log(`setup-rainbow: account ${ADDR} ${seen ? "visible in UI" : "not confirmed in UI (see sr-*-home.png)"}`);
  }
  log("setup-rainbow: done — profile at", L.PROFILE);
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { console.error("setup-rainbow failed:", e.message || e); process.exit(1); });
