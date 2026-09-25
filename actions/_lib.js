// Shared driver helpers. Every log line is stamped with the absolute epoch
// second so driver milestones align with flows.jsonl "t" (same clock: the
// guest's, which tart syncs from the host).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROFILE = path.join(LAB, "wallet-profile");   // persistent — survives into the snapshot
const WALLET = process.env.WALLET || "metamask";
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", WALLET);
const PROXY = process.env.HOST_PROXY ? `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}` : null;

const log = (...a) => console.log(`[t=${(Date.now() / 1000).toFixed(3)}]`, ...a);
const EXT_ARGS = [
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--disable-quic", "--no-first-run", "--no-default-browser-check",
];

let step = 0; let prefix = "x";
const shot = async (page, name) => {
  const f = path.join(OUT, `${prefix}-${String(++step).padStart(2, "0")}-${name}.png`);
  try { await page.screenshot({ path: f, timeout: 5000, animations: "disabled" }); } catch (e) { log(`  shot ${name} failed: ${String(e.message || e).split("\n")[0]}`); }
};
const asSel = (s) => (/[.#\[:>]/.test(s) ? s : `[data-testid="${s}"]`);
const loc = (page, s) => s.startsWith("text:") ? page.getByText(s.slice(5), { exact: false }).first()
  : s.startsWith("role:") ? page.getByRole("button", { name: new RegExp(`^${s.slice(5)}$`, "i") }).first()
  : page.locator(asSel(s)).first();

// dump every data-testid on the page (Rainbow has no LavaMoat; evaluate works)
async function dumpTestIds(page, label) {
  try {
    const ids = await page.$$eval("[data-testid]", (els) => els.map((e) => e.getAttribute("data-testid")));
    const txt = await page.$$eval("button, a, input, textarea", (els) => els.map((e) => `${e.tagName.toLowerCase()} "${(e.innerText || e.placeholder || e.value || "").trim().slice(0, 40)}"`));
    fs.writeFileSync(path.join(OUT, `diag-${label}.txt`), [...new Set(ids)].join("\n") + "\n---\n" + txt.join("\n") + "\n");
  } catch {}
}

async function clickAny(page, sels, label, { optional = false, timeout = 12000 } = {}) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of list) {
      const l = loc(page, s);
      if (await l.isVisible().catch(() => false) && await l.isEnabled().catch(() => true)) {
        let how = "click";
        try { await l.click({ timeout: 5000 }); }
        catch (e1) {
          log(`  click ${label}: ${s} failed (${String(e1.message || e1).split("\n")[0]}), retrying force`);
          try { await l.click({ timeout: 5000, force: true }); how = "force"; }
          catch (e2) { await l.dispatchEvent("click").catch(() => {}); how = "dispatch"; }
        }
        log(`  click ${label}: ${s} (${how})`);
        await page.waitForTimeout(600);
        return true;
      }
    }
    await page.waitForTimeout(400);
  }
  if (optional) { log(`  skip ${label} (not present)`); return false; }
  await shot(page, `FAIL-${label}`); await dumpTestIds(page, `FAIL-${label}`);
  throw new Error(`could not find/enable "${label}" (tried: ${list.join(", ")})`);
}

async function fillAny(page, sels, value, label, { optional = false, timeout = 12000, type = false } = {}) {
  const list = Array.isArray(sels) ? sels : [sels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of list) {
      const l = loc(page, s);
      if (await l.isVisible().catch(() => false)) {
        await l.click().catch(() => {});
        if (type) await l.pressSequentially(value, { delay: 20 }).catch(() => {});
        else await l.fill(value).catch(() => {});
        log(`  fill ${label}: ${s}`);
        return true;
      }
    }
    await page.waitForTimeout(400);
  }
  if (optional) { log(`  skip ${label} (not present)`); return false; }
  await shot(page, `FAIL-${label}`); await dumpTestIds(page, `FAIL-${label}`);
  throw new Error(`could not find input "${label}" (tried: ${list.join(", ")})`);
}

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

async function launch({ fresh = false, proxy = true } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) { console.error(`no extension at ${EXT}`); process.exit(2); }
  if (fresh) { fs.rmSync(PROFILE, { recursive: true, force: true }); }
  fs.mkdirSync(PROFILE, { recursive: true });
  const opts = { headless: false, args: EXT_ARGS, viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"] };
  // PROXY_BYPASS: hosts the browser reaches directly (e.g. a node forwarder on 127.0.0.1)
  if (proxy && PROXY) opts.proxy = { server: PROXY, ...(process.env.PROXY_BYPASS ? { bypass: process.env.PROXY_BYPASS } : {}) };
  const ctx = await chromium.launchPersistentContext(PROFILE, opts);
  const extId = await resolveExt(ctx);
  if (!extId) { console.error("extension never loaded (no SW/tab in 90s)"); process.exit(1); }
  fs.writeFileSync(path.join(OUT, "ext-id.txt"), extId + "\n");
  return { ctx, extId };
}

module.exports = { LAB, OUT, PROFILE, WALLET, EXT, log, shot, setPrefix: (p) => { prefix = p; }, asSel, loc,
  clickAny, fillAny, dumpTestIds, resolveExt, launch };
