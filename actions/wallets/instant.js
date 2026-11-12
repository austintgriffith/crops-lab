// Instant Wallet adapter (https://instantwallet.io). Not an extension: a web
// page whose first signer is a passkey. The lab stands in for Face ID with
// Chromium's virtual authenticator (CDP WebAuthn domain). The credential made
// at setup is kept in the guest profile and loaded again on every run, so the
// warm image always opens the same wallet.
//
// Selectors from instant-wallet web/tools/safe-e2e.mjs.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const L = require("../_lib");
const { log, shot, dumpTestIds } = L;

const SITE = process.env.INSTANT_URL || "https://instantwallet.io";
const CRED = path.join(L.PROFILE, "instant-passkey.json");   // guest only, never harvested
const PROXY = process.env.HOST_PROXY ? `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}` : null;

async function launch({ fresh = false, proxy = true } = {}) {
  fs.mkdirSync(L.OUT, { recursive: true });
  if (fresh) fs.rmSync(L.PROFILE, { recursive: true, force: true });
  fs.mkdirSync(L.PROFILE, { recursive: true });
  const opts = { headless: false, args: ["--disable-quic", "--no-first-run", "--no-default-browser-check"],
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  if (proxy && PROXY) opts.proxy = { server: PROXY, ...(process.env.PROXY_BYPASS ? { bypass: process.env.PROXY_BYPASS } : {}) };
  const ctx = await chromium.launchPersistentContext(L.PROFILE, opts);
  return { ctx, extId: new URL(SITE).host };
}

// Face ID stand-in. Returns the CDP session + authenticator id.
async function authenticator(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  return { cdp, authenticatorId };
}

async function saveCredential(cdp, authenticatorId) {
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  if (credentials.length !== 1) throw new Error(`expected 1 passkey, found ${credentials.length}`);
  fs.writeFileSync(CRED, JSON.stringify(credentials[0]), { mode: 0o600 });
  log(`  passkey saved in the guest profile (rpId ${credentials[0].rpId})`);
}

const address = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("iws.account") || "null")?.address || localStorage.getItem("iws.account"); } catch { return localStorage.getItem("iws.account"); }
});

async function open(ctx, _id, _args, tag) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const { cdp, authenticatorId } = await authenticator(ctx, page);
  if (!fs.existsSync(CRED)) throw new Error("no saved passkey — build the image first: WALLET=instant ./lab warm");
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: JSON.parse(fs.readFileSync(CRED, "utf8")) });
  await page.goto(SITE, { waitUntil: "load" });
  await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);   // portfolio, names, chain reads
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  log(`  open (${tag}): wallet ${await address(page)}`);
  return page;
}

// Just sit on Home: what the wallet asks for when you do nothing.
async function home(page) {
  const secs = Number(process.env.IDLE_SECS || 60);
  log(`  home: idle ${secs}s`);
  await page.waitForTimeout(secs * 1000);
}

// asset row → recipient → amount → Review. NETWORK picks the row when the
// same coin sits on several networks (default Ethereum).
async function sendForm(page, { to }, sym, amount) {
  const net = process.env.NETWORK || "Ethereum";
  const rows = page.locator(".asset", { has: page.locator(".sym", { hasText: new RegExp(`^${sym}$`) }) });
  await rows.first().waitFor({ timeout: 30000 });
  const onNet = rows.filter({ hasText: net });
  const row = (await onNet.count()) ? onNet.first() : rows.first();
  log(`  asset: ${sym} (${await rows.count()} row(s); ${(await onNet.count()) ? `on ${net}` : `no row names ${net}, took the first`})`);
  await row.click();
  await page.getByPlaceholder("0x… or name.eth").fill(to);
  // the box opens in dollars when the coin has a price
  const dollars = await page.locator(".amount-cur").isVisible().catch(() => false);
  const typed = dollars ? (process.env.SEND_USD || "0.50") : String(amount);
  await page.locator("input.amount").fill(typed);
  log(`  amount: ${dollars ? "$" : ""}${typed}${dollars ? "" : " " + sym}`);
  await shot(page, "form"); await dumpTestIds(page, "form");
  await page.getByText("Review").click();
  await page.locator(".confirm .btn-green").waitFor({ timeout: 30000 });
  await page.waitForTimeout(4000);   // preview, fee, name checks
}

const sendEth = (page, args) => sendForm(page, args, "ETH", args.amount);
const sendToken = (page, args) => sendForm(page, args, args.token, args.tokenAmount);

// Apps → Swap → from / amount / to → the quote card. Stops before .go-swap.
async function swap(page, { swapTo, swapAmount }) {
  const from = process.env.SWAP_FROM || "ETH";
  await page.locator(".balance .btn", { hasText: "Apps" }).click();
  await page.locator(".apps .asset", { has: page.locator(".sym", { hasText: /^Swap$/ }) }).click();
  const pick = async (sel, sym) => {
    if (((await sel.textContent()) || "").includes(sym)) return;
    await sel.click();
    await page.getByPlaceholder(/Type to filter|Search any token/).fill(sym.toLowerCase());
    await page.locator(".swap .picker .pill", { has: page.locator("b", { hasText: new RegExp(`^${sym}$`) }) }).first().click();
  };
  await pick(page.locator(".swap .field").first().locator(".pill.select"), from);
  const dollars = await page.locator(".swap .amount-cur").isVisible().catch(() => false);
  const typed = dollars ? (process.env.SWAP_USD || "1.00") : String(swapAmount);
  await page.locator(".swap input.amount").fill(typed);
  log(`  swap: ${dollars ? "$" : ""}${typed}${dollars ? " of" : ""} ${from} -> ${swapTo}`);
  await pick(page.locator(".swap .pair .pill.select").nth(1), swapTo);
  await shot(page, "swap-form"); await dumpTestIds(page, "swap-form");
  await page.locator(".swap .confirm:not(.pending)").waitFor({ timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".go-swap")?.disabled, null, { timeout: 45000 });
  log(`  route: ${((await page.locator(".swap .via").textContent().catch(() => "")) || "").trim()}`);
  await page.waitForTimeout(3000);
}

// Green button = the passkey signs, then the relay sends.
async function confirm(page) {
  if (await page.locator(".go-swap").isVisible().catch(() => false)) {
    await page.locator(".go-swap").click();
    await page.getByText("Swapped", { exact: true }).waitFor({ timeout: 180000 });
    return log("  swapped");
  }
  await page.locator(".confirm .btn-green").click();
  await page.getByRole("heading", { name: "Executed", exact: true }).waitFor({ timeout: 120000 });
  log("  executed");
}

module.exports = { SITE, CRED, launch, authenticator, saveCredential, address, open, home, sendEth, sendToken, swap, confirm };
