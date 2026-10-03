// Action: setup-frame — onboard Frame 0.6.11 (wallet/frame/Frame.app) once: skip the
// tutorial, add a Seed Phrase hot signer with the throwaway mnemonic, select account 1,
// so the VM can be snapshotted as crops-warm-frame. NOT a capture run.
// Flow (host probe, Oct 2): Onboard window "Let's go!" → SKIP THIS STEP → Next ×6 → Done;
// Tray "Add New Account" → Dash "Seed Phrase" → textarea → NEXT → password → CONTINUE →
// password → CREATE → click account 1.
// wallet: frame
const fs = require("fs");
const L = require("./_lib");
const F = require("./wallets/frame");
const { attach, sleep } = require("./_cdp");
const { log } = L;
const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

(async () => {
  fs.mkdirSync(L.OUT, { recursive: true });
  if (MNEMONIC.split(" ").length < 12 || !PASSWORD) { console.error("WALLET_MNEMONIC/WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx } = await F.launch();
  const on = await attach(9333, "Onboard");
  await on.clickText("Let's go!"); await sleep(1500);
  // tutorial slides: click whatever advances until "Done"
  for (let i = 0; i < 12 && !(await on.find("Done")); i++) {
    const t = await on.text(); log("  onboard:", t.slice(0, 80));
    for (const b of ["SKIP THIS STEP", "Next", "Let's go!"]) { if (await on.find(b)) { await on.clickText(b); break; } }
    await sleep(1500);
  }
  await on.clickText("Done"); await sleep(2500);
  const tray = await attach(9333, "Tray");
  await tray.clickText("Add New Account"); await sleep(2500);
  const dash = await attach(9333, "Dash");
  await dash.clickText("Seed Phrase"); await sleep(2000);
  await dash.focusField("textarea", 400); await dash.type(MNEMONIC); await sleep(500);
  await dash.clickText("NEXT", { maxX: 400 }); await sleep(1500);
  await dash.focusField("input", 400); await dash.type(PASSWORD); await sleep(500);
  await dash.clickText("CONTINUE", { maxX: 400 }); await sleep(1500);
  await dash.focusField("input", 400); await dash.type(PASSWORD); await sleep(500);
  await dash.clickText("CREATE", { maxX: 400 }); await sleep(4000);
  const text = await dash.text();
  if (ADDR && !text.toLowerCase().includes(ADDR.slice(0, 11))) throw new Error("seed imported, but WALLET_ADDR is not account 1");
  // account 1 row (shown as the first 11 chars of the address)
  const head = ADDR.slice(0, 11);
  const at = await dash.ev(`(()=>{const m=[...document.querySelectorAll("body *")].filter(e=>{const b=e.getBoundingClientRect();const t=(e.innerText||"");return b.width>0&&b.x>=0&&b.x<400&&t.length<60&&t.toLowerCase().includes(${JSON.stringify(head)})});const e=m[m.length-1];if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
  if (!at) throw new Error("frame: account 1 row not found");
  await dash.click(...at);
  await sleep(3000);
  log("  tray:", (await tray.text()).slice(0, 120));
  try { await tray.shot(`${L.OUT}/frame-setup-done.png`); } catch {}
  log("setup-frame: done — snapshot to crops-warm-frame now");
  await ctx.close();
  process.exit(0);
})().catch(async (e) => {
  console.error("setup-frame FAILED:", e.message);
  for (const t of ["Onboard", "Tray", "Dash"]) {
    try { const w = await attach(9333, t); await w.shot(`${L.OUT}/frame-FAIL-${t}.png`); console.error(`  ${t}:`, (await w.text()).slice(0, 300)); } catch {}
  }
  process.exit(1);
});
