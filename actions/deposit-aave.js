// Action: deposit-aave — route 03. Supply ETH to Aave V3 (Ethereum mainnet)
// from the MetaMask extension, while the host captures every byte. The map
// here is a DAPP flow, not just a wallet send: app.aave.com frontend + its
// data/RPC calls, the wallet-connect handshake, reserve/balance/allowance
// reads, and the supply tx construction (MetaMask simulation, gas, security
// alerts). THROWAWAY KEY ONLY.
//
// Clones crops-warm (references "wallet-profile", the flag `lab run` greps for).
// Dry by default: it drives all the way to MetaMask's tx confirmation screen —
// which is where Aave's tx is built and MetaMask simulates it — and STOPS,
// never clicking Confirm. Set AAVE_BROADCAST=1 (with explicit go-ahead) to
// actually supply. Bundled Chromium; MetaMask pages are LavaMoat-scuttled so
// the extension side is locator-only, but app.aave.com allows page.evaluate.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const AMOUNT = process.env.AAVE_AMOUNT || "0.0005";
const BROADCAST = process.env.AAVE_BROADCAST === "1";
const ARGS = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch", "--disable-quic", "--no-first-run", "--no-default-browser-check"];

let step = 0;
const shot = async (p, name) => { const f = path.join(OUT, `av-${String(++step).padStart(2, "0")}-${name}.png`); try { await p.screenshot({ path: f }); } catch {} };
async function resolveExt(ctx, ms = 90000) {
  const e = Date.now() + ms;
  while (Date.now() < e) {
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (sw) return new URL(sw.url()).host;
    const pg = ctx.pages().find((p) => p.url().startsWith("chrome-extension://"));
    if (pg) return new URL(pg.url()).host;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
async function unlockIfNeeded(p) {
  if (await p.locator('[data-testid="unlock-password"]').first().isVisible().catch(() => false)) {
    await p.locator('[data-testid="unlock-password"]').fill(PASSWORD);
    await p.locator('[data-testid="unlock-submit"]').click();
    await p.waitForTimeout(2500);
  }
}
// Surface a pending MetaMask request on the extension tab and (optionally)
// approve it. Aave's connect popup and its tx popup don't auto-open here, so
// we navigate the MM tab to notification.html, which renders the queued
// request (and, for a tx, makes MetaMask fire simulation/gas/security-alerts).
async function mmRequest(mm, id, label, { confirm, names }) {
  await mm.bringToFront();
  await mm.goto(`chrome-extension://${id}/notification.html`, { waitUntil: "load" }).catch(() => {});
  await mm.waitForTimeout(2500);
  await unlockIfNeeded(mm);
  await mm.waitForTimeout(1500);   // let the confirm screen fire its network calls
  await shot(mm, `mm-${label}`);
  if (!confirm) { console.log(`  mm ${label}: reached (NOT confirming — dry)`); return; }
  for (const rx of names) {
    const b = mm.getByRole("button", { name: rx }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); console.log(`  mm ${label}: clicked ${rx}`); await mm.waitForTimeout(2000); }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(PROFILE)) { console.error(`no ${PROFILE} — run 'lab warm' first`); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing in ~/lab/.env"); process.exit(2); }
  const ctxOpts = { headless: false, args: ARGS, viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] };
  if (process.env.HOST_PROXY) ctxOpts.proxy = { server: PROXY };
  const ctx = await chromium.launchPersistentContext(PROFILE, ctxOpts);
  const id = await resolveExt(ctx);
  if (!id) { console.error("extension never loaded"); process.exit(1); }
  console.log("deposit-aave: ext", id, "· supply", AMOUNT, "ETH · broadcast", BROADCAST);

  // Unlock the wallet up front.
  let mm = ctx.pages().find((p) => p.url().includes(id)) || await ctx.newPage();
  if (!mm.url().includes(id)) await mm.goto(`chrome-extension://${id}/home.html`, { waitUntil: "load" });
  await mm.waitForTimeout(2500);
  await unlockIfNeeded(mm);
  console.log("  wallet unlocked");

  // Load Aave, decline tracking.
  const page = await ctx.newPage();
  await page.goto("https://app.aave.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(8000);
  await page.getByRole("button", { name: /opt-?out/i }).first().click({ timeout: 4000 }).catch(() => {});
  await shot(page, "aave-landing");

  // Connect wallet -> MetaMask -> approve on the extension notification page.
  await page.getByRole("button", { name: /connect wallet/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  await shot(page, "connect-modal");
  await page.getByText("MetaMask", { exact: true }).first().click({ timeout: 6000 });
  console.log("  clicked MetaMask");
  await page.waitForTimeout(3500);
  await mmRequest(mm, id, "connect", { confirm: true, names: [/^Connect$/i, /^Next$/i, /^Confirm$/i] });
  await page.bringToFront();
  await page.waitForTimeout(6000);
  await shot(page, "connected");

  const connected = await page.getByRole("button", { name: /^supply$/i }).count().catch(() => 0);
  if (!connected) { await shot(page, "FAIL-not-connected"); throw new Error("deposit-aave: wallet did not connect (no Supply buttons)"); }
  console.log("  connected:", connected, "supply buttons");

  // Open the ETH supply modal (ETH is the top row of 'Assets to supply').
  await page.getByRole("button", { name: /^supply$/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  await shot(page, "supply-modal");

  // Enter the amount. Aave's modal input is a numeric field; try a few shapes.
  const amtSelectors = ['input[placeholder="0.00"]', 'input[type="number"]', 'input[inputmode="decimal"]', "input"];
  let filled = false;
  for (const s of amtSelectors) {
    const inp = page.locator(s).last();   // the modal input is the last-rendered one
    if (await inp.isVisible().catch(() => false)) { await inp.click().catch(() => {}); await inp.fill(AMOUNT).catch(() => {}); filled = true; console.log("  amount filled via", s); break; }
  }
  if (!filled) { await shot(page, "FAIL-amount"); throw new Error("deposit-aave: could not find the supply amount input"); }
  await page.waitForTimeout(2500);   // Aave recomputes: gas, health factor, etc.
  await shot(page, "amount-entered");

  // Click the modal's action button ("Supply ETH" / "Supply"). This asks
  // MetaMask to build+simulate the tx.
  const actionBtn = page.getByRole("button", { name: /^supply(\s+eth)?$/i }).last();
  await actionBtn.click({ timeout: 10000 });
  console.log("  clicked Supply (modal action)");
  await page.waitForTimeout(4000);

  // The tx now sits in MetaMask. In dry mode we render its confirm screen
  // (fires simulation/gas/security-alerts) but never click Confirm.
  await mmRequest(mm, id, BROADCAST ? "supply-tx" : "supply-tx-dry",
    { confirm: BROADCAST, names: [/^Confirm$/i, /^Approve$/i] });

  fs.writeFileSync(path.join(OUT, "aave.txt"),
    `MODE: ${BROADCAST ? "broadcast" : "dry"}\naction: supply ${AMOUNT} ETH to Aave V3 mainnet\nfrom: connected wallet\n`);
  console.log(`deposit-aave: ${BROADCAST ? "submitted" : "reached tx confirm (dry, not broadcast)"}`);
  await page.bringToFront();
  await page.waitForTimeout(4000);
  await ctx.close();
})().catch((e) => { console.error("deposit-aave failed:", e.message || e); process.exit(1); });
