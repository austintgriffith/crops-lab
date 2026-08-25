// wallet: metamask
// Action: bridge-metamask — route BR1. MetaMask's BUILT-IN Bridge (not a dapp).
// Moves ETH from mainnet to an L2 (Base by default). MetaMask merged Swap +
// Bridge into one quote engine (bridge.api.cx.metamask.io/getQuoteStream), so
// this exposes the cross-domain surface: the quote/route API AND whatever
// canonical bridge / relayer the route picks — the biggest new trust surface
// beyond a same-chain send.
//
// ETH is native, so NO token approval is needed. Clones crops-warm (the
// "wallet-profile" / // wallet: metamask flags tell `lab run` to use it).
//
// MetaMask scuttles globalThis (LavaMoat) so page.evaluate throws — FAIL-*.png
// is the diagnostic. Dry by default: drive to the quoted bridge screen and
// STOP. Set BRIDGE_BROADCAST=1 (with go-ahead) to submit.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO_CHAIN = process.env.BRIDGE_TO_CHAIN || "Base";
const AMOUNT = process.env.BRIDGE_AMOUNT || "0.002";
const BROADCAST = process.env.BRIDGE_BROADCAST === "1";

let step = 0;
const shot = async (page, name) => {
  const f = path.join(OUT, `br-${String(++step).padStart(2, "0")}-${name}.png`);
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
  throw new Error(`bridge-metamask: could not find "${label}" (tried: ${list.join(", ")})`);
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
  throw new Error(`bridge-metamask: could not find input "${label}" (tried: ${list.join(", ")})`);
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
  if (!extId) { console.error("bridge-metamask: extension never loaded"); process.exit(1); }
  console.log("bridge-metamask: ext", extId, "· bridge", AMOUNT, "ETH -> ", TO_CHAIN, "· broadcast", BROADCAST);

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
  await page.waitForTimeout(6000);   // let background calls (flags, tokens, prices, balances) fire
  await shot(page, "home");

  // MetaMask unified Bridge INTO Swap (no separate Bridge button). Open Swap,
  // then switch the DESTINATION NETWORK to an L2 — that turns the swap into a
  // bridge and routes the quote through the cross-chain path.
  // 1. Open Swap.
  await clickAny(page, [
    "token-overview-button-swap", "eth-overview-button-swap", "coin-overview-button-swap",
    "wallet-swap", "swap-button", "text:Swap",
  ], "open-swap");
  await page.waitForTimeout(3000);
  await shot(page, "swap-page"); await dumpTestids(page, "swap-page");

  // 2. Amount to send (source defaults to ETH on mainnet).
  await fillAny(page, [
    "prepare-swap-page-from-token-amount", "textfield", 'input[placeholder="0"]',
    "bridge-from-amount", "from-token-amount",
  ], AMOUNT, "from-amount");
  await page.waitForTimeout(2000);

  // 3. Open the destination token chip — the network selector lives inside it.
  //    The chip is the pill on the RIGHT of the "You receive" row (~x=905,
  //    y=210 at 1200x800). Click by position since it has no stable testid.
  let opened = await clickAny(page, [
    "prepare-swap-page-swap-to", "destination-token-button", "swap-to-token-button",
    "prepare-swap-page-swap-to-token",
  ], "open-dest-picker", { optional: true, timeout: 5000 });
  if (!opened) {
    await page.mouse.click(905, 210).catch(() => {});
    console.log("  open-dest-picker: clicked dest chip by position");
    opened = true;
  }
  await page.waitForTimeout(2000);
  await shot(page, "dest-picker"); await dumpTestids(page, "dest-picker");
  // The picker is "Select token" with an "All networks" FILTER at the top —
  // that's the network switch. Open it, choose the L2, then the list shows that
  // chain's tokens; pick ETH on the L2 to make it a bridge.
  await clickAny(page, ['text:All networks', 'text:Networks', "network-filter"], "open-network-filter", { optional: true, timeout: 6000 });
  await page.waitForTimeout(1500);
  await shot(page, "network-list"); await dumpTestids(page, "network-list");
  await clickAny(page, [`text:${TO_CHAIN}`], "pick-network", { optional: true, timeout: 6000 });
  await page.waitForTimeout(2000);
  await shot(page, "after-network");
  // Now the token list is filtered to the L2; pick the ETH token ROW — click
  // "Ether" (the row subtitle), NOT "Ethereum" (that's the network-filter chip
  // and re-clicking it reverts the filter to mainnet).
  await clickAny(page, ["text:Ether\n", "text:Ether", "text:ETH"], "pick-dest-token", { optional: true, timeout: 6000 });
  // Quotes settle (bridge.api.cx.metamask.io/getQuoteStream). Wait for the CTA.
  await page.waitForTimeout(10000);
  await shot(page, "quotes"); await dumpTestids(page, "quotes");

  if (!BROADCAST) {
    console.log("bridge-metamask: DRY run — reached the quoted bridge screen, NOT broadcasting (BRIDGE_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(OUT, "bridge.txt"), `MODE: dry\nbridge: ${AMOUNT} ETH -> ${TO_CHAIN}\n`);
    await page.waitForTimeout(2000);
    await ctx.close();
    return;
  }

  // 4. Confirm. On the quoted page the primary CTA reads "Swap" (ETH->token
  //    needs no approval). A confirm/summary screen may follow.
  const confirmed = await clickAny(page, [
    "swap-button", "confirm-swap-button", "swap-footer-button", "text:Swap", "text:Confirm",
  ], "confirm-swap", { optional: true, timeout: 15000 });
  console.log("  confirm-swap clicked:", confirmed);
  await page.waitForTimeout(2500);
  await shot(page, "post-swap-click");
  // Some builds show a final confirmation screen with its own Confirm/Swap.
  await clickAny(page, ["confirm-swap-button", "swap-button", "text:Confirm", "text:Swap"], "final-confirm", { optional: true, timeout: 6000 });
  await page.waitForTimeout(10000);   // broadcast + status
  await shot(page, "submitted");
  let txhash = "";
  try {
    const href = await page.locator('a[href*="/tx/0x"]').first().getAttribute("href").catch(() => "");
    const m = (href || "").match(/0x[a-fA-F0-9]{64}/);
    if (m) txhash = m[0];
  } catch {}
  fs.writeFileSync(path.join(OUT, "swap.txt"),
    `MODE: broadcast\nswap: ${AMOUNT} ${FROM_SYM} -> ${TO_SYM}\ntxhash: ${txhash || "(see flows.jsonl)"}\n`);
  console.log("bridge-metamask: submitted; txhash", txhash || "(see flows.jsonl)");
  await page.waitForTimeout(4000);
  await ctx.close();
})().catch((e) => { console.error("bridge-metamask failed:", e.message || e); process.exit(1); });
