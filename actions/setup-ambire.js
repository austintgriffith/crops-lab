// Action: setup-ambire — onboard the Ambire Web3 Wallet extension
// (wallet/ambire, 6.18.7) once by importing the throwaway mnemonic, so the VM
// can be snapshotted as crops-warm-ambire. NOT a capture run.
//
// Ambire is a SMART-ACCOUNT wallet: onboarding is heavier than an EOA wallet —
// import seed -> set a KEYSTORE password (the device lock, = WALLET_PASSWORD)
// -> pick/personalize the derived accounts -> dashboard. Selectors are the
// data-testids from the shipped bundle; the flow varies, so most steps are
// optional and the driver dumps testids on any miss (see out/diag-*.txt).
// wallet: ambire
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const L = require("./_lib");
const { log, shot, clickAny, fillAny, dumpTestIds } = L;

const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

(async () => {
  L.setPrefix("sa");
  if (MNEMONIC.split(" ").filter(Boolean).length < 12) { console.error("WALLET_MNEMONIC missing/short"); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true, proxy: false });
  log("setup-ambire: extension id", extId);

  // Capture the extension's console + failed requests so a client-side derive
  // failure (JS exception, rejected fetch) is visible, not just "went wrong".
  const errs = [];
  ctx.on("console", (m) => { if (m.type() === "error") { const t = m.text().slice(0, 200); errs.push("console.error: " + t); log("  [console.error] " + t); } });
  ctx.on("requestfailed", (r) => { const m = `${r.method()} ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`; errs.push("requestfailed: " + m); log("  [requestfailed] " + m); });
  ctx.on("weberror", (e) => { const t = String(e.error()).slice(0, 200); errs.push("pageerror: " + t); log("  [pageerror] " + t); });

  let page = ctx.pages().find((p) => p.url().includes(extId));
  if (!page) page = await ctx.newPage();
  // Ambire uses an in-memory router: tab.html boots straight to get-started.
  // (There is no get-started.html — navigating to one yields ERR_FILE_NOT_FOUND.)
  await page.goto(`chrome-extension://${extId}/tab.html`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid]").length > 0, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, "entry"); await dumpTestIds(page, "entry");

  // 1. Get started + terms
  await clickAny(page, ["get-started-button-add", "button-proceed", "proceed-btn", "text:Get started", "text:Add account"], "get-started", { optional: true, timeout: 8000 });
  await page.waitForTimeout(800);
  await clickAny(page, ["terms-of-service-btn", "keystore-setup-checkbox", "checkbox", "text:I agree", "text:Accept"], "terms", { optional: true, timeout: 5000 });
  await page.waitForTimeout(800);
  await shot(page, "after-terms"); await dumpTestIds(page, "after-terms");

  // 2. Import existing -> recovery phrase
  await clickAny(page, ["button-import-account", "import-existing-account-btn", "import-button", "text:Import"], "import-account", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1000);
  await clickAny(page, ["import-recovery-phrase", "text:Recovery Phrase", "text:Seed Phrase"], "import-seed", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1200);
  await shot(page, "seed-form"); await dumpTestIds(page, "seed-form");

  // 3. Seed. One field or a per-word grid; paste first, fall back to typing.
  // enter-seed-phrase-field is a single textarea ("Write or paste your recovery phrase").
  await fillAny(page, ["enter-seed-phrase-field", "textarea"], MNEMONIC, "seed");
  await page.waitForTimeout(1200);
  const got = await page.locator('[data-testid="enter-seed-phrase-field"]').first().inputValue().catch(() => "");
  log(`  seed field: ${got.split(/\s+/).filter(Boolean).length} words`);
  await shot(page, "seed-filled");
  // wait for import-button to enable (seed validates), then click.
  await page.waitForTimeout(1500);
  await clickAny(page, ["import-button", "text:Import"], "seed-continue", { timeout: 12000 });
  await page.waitForTimeout(2500);
  await shot(page, "after-seed"); await dumpTestIds(page, "after-seed");

  // 4. Keystore password (the device lock). Fields vary: enter-new-pass /
  //    create-keystore-pass. Fill both, tick the ack, submit.
  // Password fields need REAL keystrokes (fill() doesn't fire React validation,
  // so the submit stays disabled). terms-of-service-btn is a LINK that opens a
  // ToS modal — do NOT click it; only keystore-setup-checkbox is the ack.
  await fillAny(page, ["enter-new-pass-field", "enter-pass-field", "passphrase-field"], PASSWORD, "pw-new", { type: true, timeout: 8000 });
  await fillAny(page, ["repeat-new-pass-field", "repeat-pass-field"], PASSWORD, "pw-repeat", { type: true, timeout: 5000 });
  // The ack is the "I agree to the Terms of Service" checkbox. A plain click on
  // the testid doesn't toggle the React state; keep trying (testid, the label
  // text, then the checkbox glyph) until the Confirm button actually enables.
  const btnEnabled = async () => page.locator('[data-testid="create-keystore-pass-btn"]').first()
    .isEnabled().catch(() => false);
  for (let i = 0; i < 6 && !(await btnEnabled()); i++) {
    await clickAny(page, ["keystore-setup-checkbox", "text:I agree"], `pw-ack-${i}`, { optional: true, timeout: 3000 });
    await page.waitForTimeout(700);
  }
  await shot(page, "pass-ready");
  log(`  confirm enabled: ${await btnEnabled()}`);
  await clickAny(page, ["create-keystore-pass-btn"], "pw-submit", { timeout: 8000 });
  await page.waitForTimeout(3000);
  await shot(page, "after-pass"); await dumpTestIds(page, "after-pass");

  // 5. Account-adder. Ambire is a SMART ACCOUNT: it must reach the relayer to
  //    DERIVE the account address here — "Loading accounts" can take a while and
  //    clicking through early throws "Something went wrong with deriving the
  //    accounts". Wait for a derived account to appear, retrying the derive if it
  //    errors, then select it and continue.
  const derived = async () => page.locator('[data-testid="account-select-btn"], [data-testid="add-one-more-address"], input[type="checkbox"]').first().isVisible().catch(() => false);
  const errored = async () => page.getByText(/went wrong with deriving/i).first().isVisible().catch(() => false);
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (await derived()) { ok = true; break; }
      if (await errored()) {
        log(`  derive error (attempt ${attempt + 1}); retrying`);
        await shot(page, `derive-err-${attempt}`);
        await clickAny(page, ["text:start the process again", "text:Try again", "text:Retry", "import-recovery-phrase"], "derive-retry", { optional: true, timeout: 4000 });
        await page.waitForTimeout(2000);
        break;
      }
      await page.waitForTimeout(1500);
    }
  }
  await shot(page, "accounts"); await dumpTestIds(page, "accounts");
  if (!ok) { await shot(page, "END-DERIVE-FAIL"); throw new Error("account derivation never completed (smart-account relayer step)"); }

  // Select the first derived account, then continue through personalize -> done.
  await clickAny(page, ["account-select-btn", "text:Select"], "select-account", { optional: true, timeout: 6000 });
  await page.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    const c = await clickAny(page, ["button-save-and-continue", "import-button", "onboarding-completed-open-dashboard-btn", "go-dashboard-button", "proceed-btn", "text:Save and Continue", "text:Continue", "text:Open dashboard"], `finish-${i}`, { optional: true, timeout: 6000 });
    if (!c) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(2500);
  await shot(page, "dashboard"); await dumpTestIds(page, "dashboard");

  const seen = await page.locator('[data-testid="dashboard-button-send"]').first().isVisible().catch(() => false);
  log(`setup-ambire: dashboard ${seen ? "reached (send button visible)" : "NOT confirmed (see sa-*-dashboard.png)"}`);
  if (!seen) { await shot(page, "END-NO-DASH"); throw new Error("did not reach the Ambire dashboard"); }
  log("setup-ambire: done — profile at", L.PROFILE);
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { console.error("setup-ambire failed:", e.message || e); process.exit(1); });
