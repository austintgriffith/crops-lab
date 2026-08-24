// Action: swap-uniswap — map an ETH->USDC swap on app.uniswap.org from the
// MetaMask extension while the host captures every byte. First SWAP mapped: the
// novel leg is the QUOTE/ROUTING API (returns the route + calldata the user
// signs) and whether UniswapX (off-chain filler) is offered vs an on-chain
// Universal Router swap. THROWAWAY KEY ONLY.
//
// Clones crops-warm (references "wallet-profile", the flag `lab run` greps for).
// DRY by default: drives to MetaMask's swap-tx confirm screen — where the quote,
// route, simulation and gas all fire — and STOPS, never clicking Confirm.
// SWAP_BROADCAST=1 would submit; we deliberately do NOT auto-broadcast a trade.
// wallet: metamask
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = process.env.HOST_PROXY ? `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}` : null;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const AMOUNT = process.env.SWAP_AMOUNT || "0.0003";
const BROADCAST = process.env.SWAP_BROADCAST === "1";
const ARGS = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch", "--disable-quic", "--no-first-run", "--no-default-browser-check"];

let step = 0;
const T = () => `[t=${(Date.now() / 1000).toFixed(3)}]`;
const log = (...a) => console.log(T(), ...a);
const shot = async (p, name) => { const f = path.join(OUT, `sw-${String(++step).padStart(2, "0")}-${name}.png`); try { await p.screenshot({ path: f, timeout: 5000 }); } catch {} };
const dump = async (p, label) => { try { const t = await p.$$eval("[data-testid]", els => [...new Set(els.map(e => e.getAttribute("data-testid")))]); const b = await p.$$eval("button,a,input", els => els.map(e => `${e.tagName.toLowerCase()} "${(e.innerText||e.placeholder||"").trim().slice(0,32)}"`)); fs.writeFileSync(path.join(OUT, `diag-${label}.txt`), t.join("\n")+"\n---\n"+[...new Set(b)].join("\n")+"\n"); } catch {} };
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
// Render a queued MetaMask request on its notification page and optionally approve.
async function mmRequest(mm, id, label, { confirm, names }) {
  await mm.bringToFront();
  await mm.goto(`chrome-extension://${id}/notification.html`, { waitUntil: "load" }).catch(() => {});
  await mm.waitForTimeout(2500);
  await unlockIfNeeded(mm);
  await mm.waitForTimeout(2000);   // let the confirm screen fire its network calls
  await shot(mm, `mm-${label}`);
  if (!confirm) { log(`  mm ${label}: reached (NOT confirming — dry)`); return; }
  for (const rx of names) {
    const b = mm.getByRole("button", { name: rx }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); log(`  mm ${label}: clicked ${rx}`); await mm.waitForTimeout(2500); }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(PROFILE)) { console.error(`no ${PROFILE} — run 'lab warm' first`); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing"); process.exit(2); }
  const opts = { headless: false, args: ARGS, viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] };
  if (PROXY) opts.proxy = { server: PROXY };
  const ctx = await chromium.launchPersistentContext(PROFILE, opts);
  const id = await resolveExt(ctx);
  if (!id) { console.error("extension never loaded"); process.exit(1); }
  log("swap-uniswap: ext", id, "· swap", AMOUNT, "ETH -> USDC · broadcast", BROADCAST);

  // Unlock the wallet up front.
  let mm = ctx.pages().find((p) => p.url().includes(id)) || await ctx.newPage();
  if (!mm.url().includes(id)) await mm.goto(`chrome-extension://${id}/home.html`, { waitUntil: "load" });
  await mm.waitForTimeout(2500);
  await unlockIfNeeded(mm);
  log("  wallet unlocked");

  // Load Uniswap swap.
  const page = await ctx.newPage();
  await page.goto("https://app.uniswap.org/swap?chain=mainnet", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);   // heavy SPA + first-run analytics/config
  await page.getByRole("button", { name: /(accept|agree|got it|opt.?out|reject)/i }).first().click({ timeout: 4000 }).catch(() => {});
  await shot(page, "uni-landing"); await dump(page, "uni-landing");

  // Connect wallet -> MetaMask. The "MetaMask (Detected)" row is inside the
  // wallet modal's option grid; click the ROW (not the text span) so it fires
  // eth_requestAccounts. Then approve on the extension notification page.
  await page.getByRole("button", { name: /^connect$/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await shot(page, "connect-modal"); await dump(page, "connect-modal");
  // the option row: an element whose text contains MetaMask, inside the modal.
  const mmOption = page.locator('[data-testid="wallet-modal"] :text("MetaMask"), [data-testid="option-grid"] :text("MetaMask")').first();
  let clicked = await mmOption.click({ timeout: 6000 }).then(() => true).catch(() => false);
  if (!clicked) clicked = await page.getByText("MetaMask", { exact: false }).first().click({ timeout: 6000 }).then(() => true).catch(() => false);
  log("  connect: MetaMask option clicked:", clicked);
  await page.waitForTimeout(3500);
  // Some builds pop a separate MetaMask window; else the request queues on the tab.
  const popup = ctx.pages().find((p) => p.url().includes(id) && p !== mm);
  await mmRequest(popup || mm, id, "connect", { confirm: true, names: [/^Connect$/i, /^Next$/i, /^Confirm$/i] });
  // Uniswap may then ask for a SIWE/Privy signature to finish "connecting".
  await page.bringToFront(); await page.waitForTimeout(3000);
  await mmRequest(mm, id, "connect-sign", { confirm: true, names: [/^Sign$/i, /^Confirm$/i, /^Sign-?In$/i] });
  await page.bringToFront();
  await page.waitForTimeout(6000);
  await shot(page, "connected"); await dump(page, "connected");
  const isConn = !(await page.getByRole("button", { name: /^connect$/i }).first().isVisible().catch(() => false));
  log("  connected:", isConn);

  // Pick the "You receive" token = USDC (testid: choose-output-token).
  await page.locator('[data-testid="choose-output-token"]').first().click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/select token/i).first().click({ timeout: 8000 }).catch(() => {});
  });
  await page.waitForTimeout(2000);
  await shot(page, "token-modal"); await dump(page, "token-modal");
  const search = page.locator('input[placeholder*="Search" i], input[placeholder*="token" i], input[type="text"]').first();
  await search.fill("USDC").catch(() => {});
  await page.waitForTimeout(2500);   // token search fires a list/verify request
  await shot(page, "token-search");
  await page.getByText(/^USDC$/).first().click({ timeout: 6000 }).catch(async () => { await page.getByText("USDC", { exact: false }).first().click({ timeout: 6000 }).catch(() => {}); });
  log("  picked USDC");
  await page.waitForTimeout(2500);
  await shot(page, "pair-set"); await dump(page, "pair-set");

  // Enter the ETH amount (testid: amount-input-in).
  const amtInput = page.locator('[data-testid="amount-input-in"], input[inputmode="decimal"], input').first();
  await amtInput.click().catch(() => {});
  await amtInput.fill(AMOUNT).catch(async () => { await amtInput.pressSequentially(AMOUNT, { delay: 40 }).catch(() => {}); });
  log("  amount entered:", AMOUNT);
  await page.waitForTimeout(6000);   // <-- THE QUOTE: routing/trading API fires here
  await shot(page, "quote"); await dump(page, "quote");

  // Review the swap (testid: review-swap) -> opens the review sheet (final quote + sim).
  await page.locator('[data-testid="review-swap"]').first().click({ timeout: 10000 }).catch(async () => {
    await page.getByRole("button", { name: /^review$/i }).first().click({ timeout: 8000 }).catch(() => {});
  });
  await page.waitForTimeout(4000);
  await shot(page, "review"); await dump(page, "review");

  // Confirm on the dapp -> hands the swap tx to MetaMask.
  const confirmed = await page.getByTestId("confirm-swap-button").first().click({ timeout: 8000 }).then(() => true).catch(async () =>
    page.getByRole("button", { name: /^(confirm swap|swap)$/i }).first().click({ timeout: 6000 }).then(() => true).catch(() => false));
  log("  dapp confirm-swap clicked:", confirmed);
  await page.waitForTimeout(4000);

  // The swap tx now sits in MetaMask. Dry: render its confirm screen (fires the
  // quote/route calldata, simulation, gas) but never click Confirm.
  await mmRequest(mm, id, BROADCAST ? "swap-tx" : "swap-tx-dry",
    { confirm: BROADCAST, names: [/^Confirm$/i, /^Approve$/i] });

  fs.writeFileSync(path.join(OUT, "swap.txt"),
    `MODE: ${BROADCAST ? "broadcast" : "dry"}\naction: swap ${AMOUNT} ETH -> USDC on app.uniswap.org (mainnet)\nfrom: connected MetaMask wallet\n`);
  log(`swap-uniswap: ${BROADCAST ? "submitted" : "reached swap-tx confirm (dry, not broadcast)"}`);
  await page.bringToFront();
  await page.waitForTimeout(4000);
  await ctx.close();
})().catch((e) => { console.error("swap-uniswap failed:", e.message || e); process.exit(1); });
