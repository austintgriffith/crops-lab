// wallet: metamask
// Action: approve-swap — route AP1. Capture the ERC-20 APPROVAL surface by
// swapping a TOKEN back to ETH (mUSD -> ETH). Unlike ETH->token, an ERC-20
// INPUT must first be approved for MetaMask's swap router / Permit2 — so this
// flow adds the approve step (an eth_signTypedData Permit2 signature and/or an
// approve() tx) that M4's ETH->mUSD swap never triggers. That approval is the
// signature that drains wallets when a dapp asks for infinite allowance.
//
// Sets the SOURCE token to mUSD (opens the "You pay" token picker), amount,
// destination ETH; drives to the quote where the Approve/Permit step appears.
// Clones crops-warm. Dry by default; set APPROVE_BROADCAST=1 to submit.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const FROM_SYM = process.env.SWAP_FROM || "mUSD";
const TO_SYM = process.env.SWAP_TO || "ETH";
const AMOUNT = process.env.SWAP_AMOUNT || "2";
const BROADCAST = process.env.APPROVE_BROADCAST === "1";

let step = 0;
const shot = async (page, name) => {
  const f = path.join(OUT, `ap-${String(++step).padStart(2, "0")}-${name}.png`);
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
  throw new Error(`swap-metamask: could not find "${label}" (tried: ${list.join(", ")})`);
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
  throw new Error(`swap-metamask: could not find input "${label}" (tried: ${list.join(", ")})`);
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
  if (!extId) { console.error("approve-swap: extension never loaded"); process.exit(1); }
  console.log("approve-swap: ext", extId, "· swap", AMOUNT, FROM_SYM, "->", TO_SYM, "· broadcast", BROADCAST);

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

  // 1. Open Swap. Home shows a Buy/Swap/Bridge/Send/Receive button row.
  await clickAny(page, [
    "token-overview-button-swap", "eth-overview-button-swap", "coin-overview-button-swap",
    "wallet-swap", "swap-button", "text:Swap",
  ], "open-swap");
  await page.waitForTimeout(3000);
  await shot(page, "swap-page"); await dumpTestids(page, "swap-page");

  // 2. Reverse the direction. Default is ETH -> mUSD; the ↕ button between the
  //    two token rows flips it to mUSD -> ETH, making the TOKEN the input (which
  //    is what forces the ERC-20 approval). Cleaner than fighting the pickers.
  const flipped = await clickAny(page, [
    "prepare-swap-page-switch-tokens", "switch-tokens-button", "swap-switch-tokens",
    "switch-tokens", 'button[aria-label*="witch"]', 'button[aria-label*="everse"]',
  ], "flip-direction", { optional: true, timeout: 8000 });
  if (!flipped) {
    // Fallback: click the middle swap-arrows icon by position (between the rows).
    await page.mouse.click(595, 167).catch(() => {});
    console.log("  flip-direction: clicked middle icon by position");
  }
  await page.waitForTimeout(2500);
  await shot(page, "flipped"); await dumpTestids(page, "flipped");

  // 3. Amount of the token to swap back.
  await fillAny(page, [
    "prepare-swap-page-from-token-amount", "textfield", 'input[placeholder="0"]',
    "swap-from-amount", "from-token-amount",
  ], AMOUNT, "from-amount");
  await page.waitForTimeout(2000);

  // Destination should be ETH; if it defaulted to a token, switch it.
  {
    const opened = await clickAny(page, [
      "prepare-swap-page-swap-to", "destination-token-button", "swap-to-token-button",
    ], "open-to-picker", { optional: true, timeout: 5000 });
    if (opened) {
      await fillAny(page, ["search-token-input", 'input[placeholder*="Search"]', 'input[type="search"]'], TO_SYM, "search-to").catch(() => {});
      await page.waitForTimeout(2000);
      await clickAny(page, [`text:${TO_SYM}`], "pick-to", { optional: true, timeout: 6000 });
    }
  }
  // Quotes + the approval requirement settle. For an ERC-20 input the CTA reads
  // "Approve" (or a Permit2 signature prompt) before "Swap" becomes available.
  await page.waitForTimeout(10000);
  await shot(page, "quotes"); await dumpTestids(page, "quotes");

  if (!BROADCAST) {
    console.log("approve-swap: DRY run — reached the quoted screen (Approve/Permit surface captured), NOT broadcasting (APPROVE_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(OUT, "approve.txt"), `MODE: dry\nfrom: ${AMOUNT} ${FROM_SYM} -> ${TO_SYM}\n`);
    await page.waitForTimeout(2000);
    await ctx.close();
    return;
  }

  // 4. Confirm. For an ERC-20 input the footer CTA is "Approve" first (grants
  //    the swap router / Permit2 allowance), then it becomes "Swap". Click
  //    whichever is present, by BUTTON role (heading + nav also say "Swap").
  let confirmed = false;
  try {
    await page.getByRole("button", { name: /^(Approve|Swap)$/, exact: true }).first().click({ timeout: 12000 });
    confirmed = true; console.log("  confirm: clicked Approve/Swap button (role)");
  } catch {
    confirmed = await clickAny(page, ["swap-button", "confirm-swap-button", "swap-footer-button", "approve-button"], "confirm", { optional: true, timeout: 8000 });
  }
  console.log("  confirm clicked:", confirmed);
  await page.waitForTimeout(4000);
  await shot(page, "post-approve-click");
  // After the approval lands, the CTA flips to "Swap" — click it to finish (or
  // it's a follow-on confirm screen). Try both.
  try {
    await page.getByRole("button", { name: /^(Swap|Confirm|Approve)$/i }).first().click({ timeout: 10000 });
    console.log("  second-confirm: clicked (role)");
  } catch {
    await clickAny(page, ["confirm-swap-button", "swap-footer-button", "confirm-footer-button"], "second-confirm", { optional: true, timeout: 6000 });
  }
  // MetaMask Smart Transactions submits to a private relay and needs the
  // extension alive while it polls batchStatus and the relay lands the bundle.
  // Closing too early aborts inclusion — wait ~90s so the STX flow completes.
  await page.waitForTimeout(90000);   // STX relay: submit + batchStatus + inclusion
  await shot(page, "submitted");
  let txhash = "";
  try {
    const href = await page.locator('a[href*="/tx/0x"]').first().getAttribute("href").catch(() => "");
    const m = (href || "").match(/0x[a-fA-F0-9]{64}/);
    if (m) txhash = m[0];
  } catch {}
  fs.writeFileSync(path.join(OUT, "swap.txt"),
    `MODE: broadcast\nswap: ${AMOUNT} ${FROM_SYM} -> ${TO_SYM}\ntxhash: ${txhash || "(see flows.jsonl)"}\n`);
  console.log("approve-swap: submitted; txhash", txhash || "(see flows.jsonl)");
  await page.waitForTimeout(4000);
  await ctx.close();
})().catch((e) => { console.error("approve-swap failed:", e.message || e); process.exit(1); });
