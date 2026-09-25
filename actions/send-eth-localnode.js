// Action: send-eth-localnode — send-eth, but FIRST point MetaMask's Ethereum
// network at LOCAL_RPC (a node on the LAN) through the UI, then send. Proves
// what goes to your node and what still goes out. THROWAWAY KEY ONLY.
//
// Assumes the wallet already exists: this clones crops-warm (built by `lab
// warm`), so ~/lab/wallet-profile is already onboarded with the throwaway key
// imported. We only UNLOCK and send — never onboard here. The network capture
// around the send is the product; the UI dance is the cost of getting it.
// Referencing "wallet-profile" below is also the flag `lab run` greps for to
// know it must clone crops-warm instead of crops-gold.
//
// Default recipient is our own address (self-send): it exercises the entire
// route-01 path — nonce, gas oracle, simulation, security alert, broadcast,
// STX status — while the ETH returns minus gas. Override with SEND_TO.
//
// Selectors are MetaMask 13.45.0 data-testids. Same defensive helpers as
// setup-wallet.js: try testid, screenshot, dump testids on a miss.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const TO = process.env.SEND_TO || process.env.WALLET_ADDR || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0002";
// Safety gate: the final Confirm broadcasts a real mainnet tx (spends gas).
// Default is a DRY run — reach the confirm screen (which already fires
// simulation, gas, security alerts) and STOP. Set SEND_BROADCAST=1 in
// .env.crops only with explicit go-ahead to actually submit.
const BROADCAST = process.env.SEND_BROADCAST === "1";

let step = 0;
const shot = async (page, name) => {
  const f = path.join(OUT, `se-${String(++step).padStart(2, "0")}-${name}.png`);
  try { await page.screenshot({ path: f }); } catch {}
};
const sel = (s) => (/[.#\[]/.test(s) ? s : `[data-testid="${s}"]`);

// Chrome 128+ disables --load-extension unless this feature is turned back off.
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
      const loc = page.locator(sel(s)).first();
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
  throw new Error(`send-eth: could not find "${label}" (tried: ${list.join(", ")})`);
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
  throw new Error(`send-eth: could not find input "${label}" (tried: ${list.join(", ")})`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) { console.error(`no extension at ${EXT}`); process.exit(2); }
  if (!fs.existsSync(PROFILE)) { console.error(`no ${PROFILE} — run 'lab warm' first`); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing in ~/lab/.env"); process.exit(2); }
  if (!TO) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }

  // Bundled Chromium (real Chrome 151 blocks --load-extension). Must match the
  // browser setup-wallet used, so the vault stored under the extension origin
  // in wallet-profile is the same one we unlock here.
  const ctxOpts = {
    headless: false,
    args: EXT_ARGS,
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  };
  // Only route through the proxy when the lab gave us one. Proxy-less launch
  // (direct NAT) is for local UI-selector iteration, not a capture run.
  if (process.env.HOST_PROXY) ctxOpts.proxy = { server: PROXY };
  let ctx = await chromium.launchPersistentContext(PROFILE, ctxOpts);

  const extId = await resolveExt(ctx);
  if (!extId) { console.error("send-eth: extension never loaded (no SW, no extension tab in 90s)"); process.exit(1); }
  console.log("send-eth: extension id", extId, "-> send", AMOUNT_ETH, "ETH to", TO);

  let page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await shot(page, "open");

  // Unlock if the lock screen is up (a snapshot boot usually locks the vault).
  if (await page.locator(sel("unlock-password")).first().isVisible().catch(() => false)) {
    await fillAny(page, ["unlock-password"], PASSWORD, "unlock-pw");
    await clickAny(page, ["unlock-submit"], "unlock");
    await page.waitForTimeout(2500);
  }
  // Let the wallet settle + fire its background calls (flags, tokens, prices,
  // balances) — those are route-01 "background" rows and we want them captured.
  await page.waitForTimeout(6000);
  await shot(page, "home");

  // ---- point Ethereum at the local node, through the UI ----
  const LOCAL_RPC = process.env.LOCAL_RPC || "http://192.168.68.54:8545";
  const T = () => `[t=${(Date.now() / 1000).toFixed(3)}]`;
  const html = async (label) => { try { fs.writeFileSync(path.join(OUT, `html-${label}.html`), await page.content()); } catch {} };
  const tryClick = async (locs, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const l of locs) {
        if (await l.first().isVisible().catch(() => false)) {
          await l.first().click({ timeout: 5000 }).catch(() => {});
          console.log(`${T()}   rpc ${label}: clicked`);
          await page.waitForTimeout(900);
          return true;
        }
      }
      await page.waitForTimeout(300);
    }
    await shot(page, `FAIL-rpc-${label}`); await html(`FAIL-rpc-${label}`);
    throw new Error(`rpc-edit: could not click ${label}`);
  };
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  console.log(`${T()} rpc-edit: start -> ${LOCAL_RPC}`);
  await tryClick([tid("network-display"), tid("network-selector-button"), tid("sort-by-networks")], "open-networks");
  await tryClick([page.getByText("Manage networks", { exact: true })], "manage-networks");
  await page.waitForTimeout(1500);
  await shot(page, "rpc-networks"); await html("rpc-networks");
  await tryClick([tid("network-list-item-options-button-eip155:1"), tid("network-list-item-options-button-0x1"), page.locator('[data-testid^="network-list-item-options-button"]').first()], "eth-options");
  await tryClick([tid("network-list-item-options-edit"), page.getByText("Edit", { exact: true })], "edit");
  await shot(page, "rpc-edit-form"); await html("rpc-edit-form");
  await tryClick([tid("test-add-rpc-drop-down"), page.getByText("Default RPC URL", { exact: false }).locator("xpath=following::button[1]"), page.getByText("infura", { exact: false })], "rpc-dropdown");
  await shot(page, "rpc-dropdown");
  await tryClick([page.getByText("Add RPC URL", { exact: true })], "add-rpc");
  await tid("rpc-url-input-test").first().fill(LOCAL_RPC);
  await tid("rpc-name-input-test").first().fill("Local node").catch(() => {});
  await page.waitForTimeout(1500);   // MetaMask probes the URL's chain id here
  await shot(page, "rpc-url-filled");
  await tryClick([page.getByRole("button", { name: /^Add URL$/i })], "add-url", 15000);
  await shot(page, "rpc-added");
  await tryClick([page.getByRole("button", { name: /^Save$/i })], "save", 10000);
  await page.waitForTimeout(2000);
  await shot(page, "rpc-saved"); await html("rpc-saved");
  await page.keyboard.press("Escape").catch(() => {});
  // Restart the browser so every startup call also runs with the node already set.
  await ctx.close();
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`${T()} rpc-edit: done — browser restarted; everything after this is on the local node setting`);
  ctx = await chromium.launchPersistentContext(PROFILE, ctxOpts);
  if (!(await resolveExt(ctx))) throw new Error("extension did not come back after restart");
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  if (await page.locator(sel("unlock-password")).first().isVisible().catch(() => false)) {
    await fillAny(page, ["unlock-password"], PASSWORD, "unlock-pw-2");
    await clickAny(page, ["unlock-submit"], "unlock-2");
  }
  await page.waitForTimeout(8000);   // background calls on the new RPC
  await shot(page, "home-local");

  // Send -> pick asset (13.45 opens an asset picker first) -> recipient -> amount -> confirm.
  await clickAny(page, ["eth-overview-send", "coin-overview-send"], "send");
  await page.waitForTimeout(1500);
  await shot(page, "asset-picker");
  // Pick the funded mainnet ETH row (top of the balance-sorted list). No
  // testid on the rows; click the row directly (auto-waits for actionable),
  // falling back to the balance text. clickAny's visibility gate can land on
  // an sr-only duplicate here, so do it inline.
  {
    const byName = page.getByText("Ethereum", { exact: true }).first();
    const byBal = page.getByText("0.00200", { exact: false }).first();
    let picked = false;
    for (const row of [byName, byBal]) {
      try { await row.scrollIntoViewIfNeeded({ timeout: 3000 }); await row.click({ timeout: 6000 }); picked = true; break; } catch {}
    }
    if (!picked) { await shot(page, "FAIL-pick-eth"); throw new Error("send-eth: could not pick the ETH asset row"); }
    console.log("  pick-eth: clicked ETH row");
  }
  await page.waitForTimeout(1500);
  await shot(page, "send-to");
  await fillAny(page, ["recipient-address-input", "recipient-address", "ens-input", "#address", "textarea"], TO, "recipient");
  await page.waitForTimeout(1500);   // recipient screening (security-alerts) fires here
  await fillAny(page, ['input[placeholder="0"]', "amount-input-field", "amount-input", "currency-input", "#amount"], AMOUNT_ETH, "amount");
  await page.waitForTimeout(1500);
  await shot(page, "amount");
  // Continue button: target by role (auto-waits for enabled). clickAny's text
  // gate can miss it.
  await page.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 10000 });
  console.log("  continue: clicked");
  await page.waitForTimeout(2000);

  // First-time recipients trigger a "New address" warning modal (Cancel /
  // Continue). Self-sends skip it; sending to a fresh address hits it. Click
  // the dialog's Continue, scoped to the dialog so we don't hit the page one.
  if (await page.getByText("New address", { exact: false }).first().isVisible().catch(() => false)) {
    const dlgContinue = page.getByRole("dialog").getByRole("button", { name: /^Continue$/i }).first();
    await dlgContinue.click({ timeout: 8000 }).catch(async () => {
      await page.getByRole("button", { name: /^Continue$/i }).last().click({ timeout: 8000 }).catch(() => {});
    });
    console.log("  new-address modal: continued");
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(2500);   // simulation + PPOM/Blockaid security alert fire on the confirm screen
  await shot(page, "confirm");

  if (!BROADCAST) {
    // DRY run: everything up to here is captured; do NOT click Confirm.
    console.log("send-eth: DRY run — stopped at confirm screen, NOT broadcasting (set SEND_BROADCAST=1 to submit)");
    fs.writeFileSync(path.join(OUT, "tx.txt"), `MODE: dry (no broadcast)\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\n`);
    await page.waitForTimeout(2000);
    await ctx.close();
    return;
  }

  // Confirm button by role (auto-waits for enabled); testid fallback.
  try {
    await page.getByRole("button", { name: /^Confirm$/i }).first().click({ timeout: 12000 });
    console.log("  confirm: clicked (role)");
  } catch {
    await clickAny(page, ["confirm-footer-button", "confirm-btn"], "confirm", { timeout: 8000 });
  }
  // Broadcast + STX status polling happen now; give them room and grab the hash.
  await page.waitForTimeout(9000);
  await shot(page, "activity");
  let txhash = "";
  try {
    await clickAny(page, ["activity-list-item"], "open-activity", { optional: true, timeout: 6000 });
    await page.waitForTimeout(1500);
    // page.evaluate is unavailable (LavaMoat); read the hash from a link instead.
    const href = await page.locator('a[href*="/tx/0x"]').first().getAttribute("href").catch(() => "");
    const m = (href || "").match(/0x[a-fA-F0-9]{64}/);
    if (m) txhash = m[0];
  } catch {}
  fs.writeFileSync(path.join(OUT, "tx.txt"), `MODE: broadcast\nto: ${TO}\namount_eth: ${AMOUNT_ETH}\ntxhash: ${txhash || "(not captured from UI — check flows.jsonl)"}\n`);
  console.log("send-eth: submitted; txhash", txhash || "(see flows.jsonl)");
  await shot(page, "done");

  await page.waitForTimeout(4000);
  await ctx.close();
})().catch((e) => { console.error("send-eth failed:", e.message || e); process.exit(1); });
