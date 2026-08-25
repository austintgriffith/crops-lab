// wallet: metamask
// Action: buy-metamask — route ON1. MetaMask's BUILT-IN "Buy" (fiat on-ramp).
// The ENTRY to the whole funnel — where fiat becomes crypto and you hand over
// the most: region, IP-geolocation, and (at the provider) full KYC + bank.
//
// This maps the on-ramp AGGREGATOR surface: on-ramp.api.cx.metamask.io picks
// which providers (MoonPay / Coinbase / Transak…) you're offered, keyed to
// your detected REGION; providers geolocate your IP before you type anything.
// We drive to the provider/quote screen and STOP — we do NOT complete a
// purchase (that needs real KYC + payment, which we never enter). The mappable,
// valuable part is who your identity gets handed to, and that fires here.
//
// NEVER set a broadcast/purchase flag — this action is capture-only by design.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const AMOUNT = process.env.BUY_AMOUNT || "50";   // fiat amount to quote (USD)

let step = 0;
const shot = async (page, name) => {
  const f = path.join(OUT, `sw-${String(++step).padStart(2, "0")}-${name}.png`);
  try { await page.screenshot({ path: f }); } catch {}
};
const sel = (s) => (/[.#\[]/.test(s) ? s : `[data-testid="${s}"]`);

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

async function dumpTestids(page, label) {
  try {
    const data = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
      const btns = [...document.querySelectorAll("button, a[role=button]")].map((e) => (e.innerText || "").trim()).filter(Boolean);
      return { ids: [...new Set(ids)], btns: [...new Set(btns)], url: location.href };
    });
    fs.writeFileSync(path.join(OUT, `diag-${label}.txt`),
      `url: ${data.url}\n\ntestids:\n${data.ids.join("\n")}\n\nbutton text:\n${data.btns.join("\n")}\n`);
  } catch {}
}

async function clickAny(page, sels, label, { optional = false, timeout = 12000 } = {}) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of list) {
      const loc = s.startsWith("text:") ? page.getByText(s.slice(5), { exact: false }).first() : page.locator(sel(s)).first();
      if (await loc.isVisible().catch(() => false)) {
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
  await dumpTestids(page, label);
  throw new Error(`buy-metamask: could not find "${label}" (tried: ${list.join(", ")})`);
}

async function fillAny(page, sels, value, label) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    for (const s of list) {
      const loc = page.locator(sel(s)).first();
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
  await dumpTestids(page, label);
  throw new Error(`buy-metamask: could not find input "${label}" (tried: ${list.join(", ")})`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) { console.error(`no extension at ${EXT}`); process.exit(2); }
  if (!fs.existsSync(PROFILE)) { console.error(`no ${PROFILE} — run 'lab warm' first`); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing in ~/lab/.env"); process.exit(2); }

  const ctxOpts = {
    headless: false,
    args: EXT_ARGS,
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  };
  if (process.env.HOST_PROXY) ctxOpts.proxy = { server: PROXY };
  const ctx = await chromium.launchPersistentContext(PROFILE, ctxOpts);

  const extId = await resolveExt(ctx);
  if (!extId) { console.error("buy-metamask: extension never loaded"); process.exit(1); }
  console.log("buy-metamask: ext", extId, "· on-ramp quote for", AMOUNT, "USD (capture only, never purchasing)");

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await shot(page, "open");

  // Unlock — wait for the lock field to mount before deciding (avoids the race).
  const locked = await page.locator(sel("unlock-password")).first()
    .waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  if (locked) {
    await fillAny(page, ["unlock-password"], PASSWORD, "unlock-pw");
    await clickAny(page, ["unlock-submit"], "unlock");
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(6000);   // background calls (incl. the on-ramp region + provider fetch)
  await shot(page, "home");

  // 1. Open Buy (fiat on-ramp). Home button row: Buy / Swap / Send / Receive.
  await clickAny(page, [
    "token-overview-button-buy", "eth-overview-button-buy", "coin-overview-button-buy",
    "wallet-buy", "buy-button", "text:Buy",
  ], "open-buy");
  await page.waitForTimeout(4000);
  await shot(page, "buy-page"); await dumpTestids(page, "buy-page");

  // 2. Enter a fiat amount so the aggregator fetches provider quotes (region-
  //    keyed). This is where on-ramp.api.cx.metamask.io returns the providers
  //    (MoonPay/Coinbase/Transak) and they geolocate your IP.
  await fillAny(page, [
    "buy-input-amount", "fiat-amount-input", 'input[placeholder*="0"]', "textfield", 'input[inputmode="decimal"]',
  ], AMOUNT, "fiat-amount").catch(() => {});
  await page.waitForTimeout(3000);
  await shot(page, "amount");

  // 3. Try to reach the provider/quotes list (this fires the provider fetch).
  await clickAny(page, [
    "get-quotes-button", "buy-quote-button", "text:Get quotes", "text:Continue", "text:Next",
  ], "get-quotes", { optional: true, timeout: 8000 });
  await page.waitForTimeout(9000);   // providers + quotes settle
  await shot(page, "providers"); await dumpTestids(page, "providers");

  // STOP HERE — never proceed into a provider's KYC/payment. The mappable part
  // (aggregator + region + provider list + IP geolocation) has already fired.
  console.log("buy-metamask: reached the on-ramp provider/quote surface — STOPPING (never entering KYC or payment)");
  fs.writeFileSync(path.join(OUT, "buy.txt"),
    `MODE: capture-only (no purchase, no KYC)\nfiat_amount_usd: ${AMOUNT}\nnote: stopped at provider/quote screen; identity handoff surface captured\n`);
  await page.waitForTimeout(2000);
  await ctx.close();
})().catch((e) => { console.error("buy-metamask failed:", e.message || e); process.exit(1); });
