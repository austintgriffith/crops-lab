// Action: setup-wallet — onboard MetaMask once so the VM can be snapshotted as
// crops-warm (a wallet that already exists). NOT a capture run: no proxy, no
// assertions about traffic. The product is the on-disk wallet state, which
// lives in ~/lab/wallet-profile and rides along in the tart snapshot. `lab run
// send-eth` later clones that image and only has to *unlock*.
//
// MetaMask 13.45's onboarding leads with social login; the only deterministic,
// no-external-auth path is "Import using Secret Recovery Phrase". So we import
// a throwaway 12-word mnemonic (generated on the host, in ~/lab/.env) and fund
// its own account 0 — no separate private-key import step. Flow:
//   entry -> onboarding-import-wallet (switch to import mode)
//         -> "Import using Secret Recovery Phrase"
//         -> textarea [data-testid=import-srp] = mnemonic -> Continue
//         -> create password -> done
//
// Runs on Playwright's bundled Chromium (real Chrome 151 blocks
// --load-extension). page.evaluate is unavailable here — MetaMask's LavaMoat
// scuttles globalThis — so everything is locator/text based, and a FAIL-*.png
// screenshot is the diagnostic when a selector drifts.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");   // persistent — survives into the snapshot
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

const EXT_ARGS = [
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--disable-quic", "--no-first-run", "--no-default-browser-check",
];

async function resolveExt(ctx, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (sw) return new URL(sw.url()).host;
    const pg = ctx.pages().find((p) => p.url().startsWith("chrome-extension://"));
    if (pg) return new URL(pg.url()).host;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

let step = 0;
const shot = async (page, name) => {
  const f = path.join(OUT, `sw-${String(++step).padStart(2, "0")}-${name}.png`);
  try { await page.screenshot({ path: f }); } catch {}
};
const asSel = (s) => (/[.#\[]/.test(s) ? s : `[data-testid="${s}"]`);

// click by testid OR visible text. `text:Foo` in the list matches by text.
async function clickAny(page, sels, label, { optional = false, timeout = 12000 } = {}) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of list) {
      const loc = s.startsWith("text:")
        ? page.getByText(s.slice(5), { exact: false }).first()
        : page.locator(asSel(s)).first();
      if (await loc.isVisible().catch(() => false) && await loc.isEnabled().catch(() => true)) {
        await loc.click().catch(() => {});
        console.log(`  click ${label}: ${s}`);
        await page.waitForTimeout(600);
        return true;
      }
    }
    await page.waitForTimeout(400);
  }
  if (optional) { console.log(`  skip ${label} (not present)`); return false; }
  await shot(page, `FAIL-${label}`);
  throw new Error(`setup-wallet: could not find/enable "${label}" (tried: ${list.join(", ")})`);
}

async function fillAny(page, sels, value, label) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    for (const s of list) {
      const loc = page.locator(asSel(s)).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click().catch(() => {});
        await loc.fill(value).catch(() => {});
        console.log(`  fill ${label}: ${s}`);
        return true;
      }
    }
    await page.waitForTimeout(400);
  }
  await shot(page, `FAIL-${label}`);
  throw new Error(`setup-wallet: could not find input "${label}" (tried: ${list.join(", ")})`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) { console.error(`no extension at ${EXT}`); process.exit(2); }
  if (MNEMONIC.split(" ").filter(Boolean).length < 12) { console.error("WALLET_MNEMONIC missing/short in ~/lab/.env"); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing in ~/lab/.env"); process.exit(2); }

  fs.rmSync(PROFILE, { recursive: true, force: true });   // fresh onboarding
  fs.mkdirSync(PROFILE, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, args: EXT_ARGS, viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const extId = await resolveExt(ctx);
  if (!extId) { console.error("extension never loaded (no SW/tab in 90s)"); process.exit(1); }
  console.log("setup-wallet: extension id", extId);
  fs.writeFileSync(path.join(OUT, "ext-id.txt"), extId + "\n");

  let page = ctx.pages().find((p) => p.url().includes(extId));
  if (!page) { page = await ctx.newPage(); await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" }); }
  await page.bringToFront();
  await page.waitForTimeout(3500);
  await shot(page, "entry");

  // 1. Switch to import mode, then open the SRP import form.
  await clickAny(page, ["onboarding-import-wallet", "text:Already have a wallet"], "import-mode", { optional: true, timeout: 8000 });
  await page.waitForTimeout(1000);
  await clickAny(page, ["text:Import using Secret Recovery Phrase", "text:Use Secret Recovery Phrase"], "open-srp");

  // 2. Type the mnemonic into the single textarea (fill() doesn't stick —
  // MetaMask's SRP field only accepts real keystrokes), then Continue.
  await page.waitForTimeout(1500);
  await shot(page, "srp-form");
  const srp = page.locator(asSel("import-srp")).first();
  await srp.waitFor({ state: "visible", timeout: 12000 });
  // This field ignores fill() and typed keystrokes (paranoid SRP entry); it
  // only takes a real paste. Put the phrase on the guest pasteboard and Cmd+V.
  try { execSync("pbcopy", { input: MNEMONIC }); } catch (e) { console.log("  pbcopy failed:", e.message); }
  await srp.click();
  await page.keyboard.press("Meta+V");
  await page.waitForTimeout(800);
  let got = await srp.inputValue().catch(() => "");
  if (got.split(/\s+/).filter(Boolean).length < 12) {
    // fallback: MetaMask's own "Paste" button (uses the clipboard API)
    await clickAny(page, ["text:Paste"], "srp-paste-btn", { optional: true, timeout: 3000 });
    await page.waitForTimeout(600);
    got = await srp.inputValue().catch(() => "");
  }
  console.log(`  srp pasted (${got.split(/\s+/).filter(Boolean).length} words in field)`);
  await shot(page, "srp-filled");
  await clickAny(page, ["import-srp-confirm", "text:Continue"], "srp-continue");

  // 3. Optional MetaMetrics screen, then create password.
  await page.waitForTimeout(2500);
  await clickAny(page, ["metametrics-i-agree", "text:I agree", "text:No thanks"], "metrics", { optional: true, timeout: 6000 });
  await shot(page, "password");
  await fillAny(page, ["create-password-new-input", "create-password-new"], PASSWORD, "pw-new");
  await fillAny(page, ["create-password-confirm-input", "create-password-confirm"], PASSWORD, "pw-confirm");
  await clickAny(page, ["create-password-terms"], "pw-terms", { optional: true, timeout: 4000 });
  await clickAny(page, ["create-password-submit", "create-password-wallet", "text:Import my wallet", "text:Create password"], "pw-submit");

  // 4. Post-onboarding gauntlet: biometrics offer, "Help improve MetaMask"
  // data opt-in (leave the default: basic usage on = route-01 segment traffic),
  // pin-extension, "got it" popovers. Order varies; loop through the known
  // advance/dismiss buttons until none are left.
  await page.waitForTimeout(3000);
  await shot(page, "complete");
  const advance = ["onboarding-complete-done", "text:Maybe later", "text:Continue",
    "text:Open wallet", "text:Got it", "text:Done", "text:Next", "text:Not now", "text:No thanks", "text:Skip"];
  for (let i = 0; i < 6; i++) {
    const clicked = await clickAny(page, advance, `advance-${i}`, { optional: true, timeout: 5000 });
    if (!clicked) break;
    await page.waitForTimeout(1200);
  }

  // 5. Land on the wallet home; best-effort check the funded address is present.
  await page.waitForTimeout(2500);
  await shot(page, "home");
  if (ADDR) {
    const short = ADDR.slice(2, 6);   // 4 hex after 0x — appears in the truncated address
    const seen = await page.getByText(short, { exact: false }).first().isVisible().catch(() => false);
    console.log(`setup-wallet: account ${ADDR} ${seen ? "visible in UI" : "not confirmed in UI (see sw-*-home.png)"}`);
  }
  console.log("setup-wallet: done — profile at", PROFILE);
  await page.waitForTimeout(1500);
  await ctx.close();
})().catch((e) => { console.error("setup-wallet failed:", e.message || e); process.exit(1); });
