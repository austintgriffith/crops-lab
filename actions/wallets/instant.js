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

// IW_LOCAL=1: the local copy (run-local.sh) inside this VM, at local.instantwallet.io.
const LOCAL = process.env.IW_LOCAL === "1";
const SITE = process.env.INSTANT_URL || (LOCAL ? "https://local.instantwallet.io" : "https://instantwallet.io");
const CRED = path.join(L.PROFILE, "instant-passkey.json");   // guest only, never harvested
const PROXY = process.env.HOST_PROXY ? `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}` : null;

// ── local copy ─────────────────────────────────────────────────────────
// Starts run-local.sh once per action (the image has it built: crops-warm-instant-local).
// Its server, indexer, git and npm reach the internet through the lab proxy
// (NODE_USE_ENV_PROXY), so their calls land decrypted in flows.jsonl next to the
// browser's. Tor (tor-js opens raw TCP) and the LAN node bypass it: pcap only.
// IW_NODE_ENV=<url>: answer run-local's "your node?" (RPC_URL_1 in .env.local):
// the server's reads and relay, and the indexer, use it.
const { spawn, execSync } = require("child_process");
const IW = path.join(process.env.HOME, "instant-wallet");
let server = null;
function localStart() {
  if (!LOCAL || server) return;
  const envFile = path.join(IW, "web/.env.local");
  let env = fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l && !l.startsWith("RPC_URL_")).join("\n") + "\n";
  if (process.env.IW_NODE_ENV) env += `RPC_URL_1=${process.env.IW_NODE_ENV}\n`;
  fs.writeFileSync(envFile, env, { mode: 0o600 });
  const ca = [path.join(L.LAB, "mitm-ca-cert.pem"), "/tmp/crops/mitm-ca-cert.pem"].find((f) => fs.existsSync(f));
  const bundle = "/tmp/iw-ca-bundle.pem";
  if (ca) fs.writeFileSync(bundle, fs.readFileSync("/etc/ssl/cert.pem", "utf8") + "\n" + fs.readFileSync(ca, "utf8"));
  const lan = (process.env.IW_NODE_ENV || "").match(/^https?:\/\/([^/:]+)/)?.[1];
  const senv = { ...process.env, NO_OPEN: "1",
    ...(PROXY ? { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, http_proxy: PROXY, NODE_USE_ENV_PROXY: "1",
      NO_PROXY: ["localhost", "127.0.0.1", "local.instantwallet.io", lan].filter(Boolean).join(","),
      no_proxy: ["localhost", "127.0.0.1", "local.instantwallet.io", lan].filter(Boolean).join(",") } : {}),
    ...(ca ? { NODE_EXTRA_CA_CERTS: ca, GIT_SSL_CAINFO: bundle, npm_config_cafile: bundle } : {}) };
  const out = fs.openSync(path.join(L.OUT, "run-local.log"), "a");
  log(`  local: run-local.sh (node env: ${process.env.IW_NODE_ENV || "none"}; server via proxy: ${!!PROXY})`);
  server = spawn("./run-local.sh", [], { cwd: IW, env: senv, stdio: ["ignore", out, out], detached: true });
  for (let i = 0; i < 120; i++) {
    try { execSync("curl -sf --noproxy '*' http://127.0.0.1:3000/api/version", { stdio: "ignore" }); log(`  local: up after ~${i * 2}s`); break; }
    catch { execSync("sleep 2"); }
  }
  try { execSync("curl -sf --noproxy '*' http://127.0.0.1:4100/status", { stdio: "ignore" }); log("  local: indexer up on :4100"); } catch { log("  local: no indexer"); }
  process.on("exit", () => { try { process.kill(-server.pid); } catch {} });
}

// every request the page makes, local ones too (the proxy never sees those)
function pageLog(ctx) {
  const f = path.join(L.OUT, "page-requests.tsv");
  ctx.on("request", (r) => {
    try { const u = new URL(r.url()); if (u.protocol.startsWith("http"))
      fs.appendFileSync(f, `${(Date.now() / 1000).toFixed(3)}\t${r.method()}\t${u.host}\t${u.pathname}\t${r.resourceType()}\t${(r.postData() || "").slice(0, 300).replace(/\s+/g, " ")}\n`); } catch {}
  });
}

async function launch({ fresh = false, proxy = true } = {}) {
  fs.mkdirSync(L.OUT, { recursive: true });
  localStart();
  if (fresh) fs.rmSync(L.PROFILE, { recursive: true, force: true });
  fs.mkdirSync(L.PROFILE, { recursive: true });
  const opts = { headless: false, args: ["--disable-quic", "--no-first-run", "--no-default-browser-check"],
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  if (proxy && PROXY) opts.proxy = { server: PROXY, ...(process.env.PROXY_BYPASS ? { bypass: process.env.PROXY_BYPASS } : {}) };
  const ctx = await chromium.launchPersistentContext(L.PROFILE, opts);
  pageLog(ctx);
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
  // a new origin (the local copy) has no saved account: sign in with the passkey
  const pick = page.getByRole("button", { name: "Select existing passkey" });
  await Promise.race([page.getByText("Deposit", { exact: true }).waitFor({ timeout: 60000 }), pick.waitFor({ timeout: 60000 })]).catch(() => {});
  if (await pick.isVisible().catch(() => false)) { log("  sign in: Select existing passkey"); await pick.click(); }
  await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);   // portfolio, names, chain reads
  await shot(page, `home-${tag}`); await dumpTestIds(page, `home-${tag}`);
  log(`  open (${tag}): wallet ${await address(page)}`);
  return page;
}

// Settings → Your node on Ethereum, in the UI (the own-node rule: set it where a user would).
async function setRpc(page, _id, url) {
  await page.locator('[aria-label="Settings"]').first().click();
  const card = page.locator(".card.step", { hasText: "Your node on" });
  await card.waitFor({ timeout: 30000 });
  log(`  settings: ${((await card.locator("b").first().textContent()) || "").trim()}`);
  if (!/Ethereum/.test((await card.textContent()) || "")) throw new Error("Settings opened on another network than Ethereum");
  await card.getByPlaceholder("Default node").fill(url);
  await card.getByRole("button", { name: "Save" }).click();
  const ok = page.getByText(/Using your node on/);
  await ok.waitFor({ timeout: 120000 });
  log(`  settings: ${(await ok.first().textContent()).trim()}`);
  await shot(page, "rpc-saved"); await dumpTestIds(page, "rpc-saved");
  const ix = page.locator(".card.step", { hasText: "Balances and prices" });
  if (await ix.isVisible().catch(() => false)) log(`  settings: balances and prices: ${((await ix.textContent()) || "").replace(/\s+/g, " ").slice(0, 160)}`);
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

module.exports = { SITE, CRED, LOCAL, launch, setRpc, authenticator, saveCredential, address, open, home, sendEth, sendToken, swap, confirm };
