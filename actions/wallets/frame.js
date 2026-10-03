// Frame adapter (wallet/frame = Frame.app 0.6.11, desktop Electron app, not an extension).
// Frame has no send form of its own: its tray opens send.frame.eth, a dapp it resolves
// via ENS and serves from a local server (send.frame.eth.localhost:8421). Signing happens
// in Frame's tray window. Driven over CDP (actions/_cdp.js); flows from host probes, Oct 2.
// Frame's renderer windows follow --proxy-server; its main process (node sockets, e.g. the
// Pylon RPC websocket) does not, so those show only in the pcap (BYPASS + DNS names).
const { spawn } = require("child_process");
const path = require("path");
const L = require("../_lib");
const { attach, pages, sleep } = require("../_cdp");
const { log } = L;

const PORT = 9333;
const APP = path.join(L.LAB, "wallet", "frame", "Frame.app", "Contents", "MacOS", "Frame");
const DATA = path.join(L.LAB, "frame-profile");   // persistent — survives into the warm snapshot
const win = (name) => attach(PORT, name);
const shot = async (w, name) => { try { await w.shot(path.join(L.OUT, `frame-${name}.png`)); } catch {} };

async function launch() {
  const args = [`--user-data-dir=${DATA}`, `--remote-debugging-port=${PORT}`];
  if (process.env.HOST_PROXY) args.push(`--proxy-server=http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`);
  const proc = spawn(APP, args, { stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    const p = await pages(PORT).catch(() => []);
    if (p.some((x) => x.title === "Tray")) break;
    await sleep(1000);
  }
  await sleep(4000);
  log("frame: launched, windows", (await pages(PORT)).map((p) => p.title).join(", "));
  return { ctx: { close: async () => { try { process.kill(-proc.pid); } catch { proc.kill(); } await sleep(2000); } }, extId: "frame" };
}

// select the account, unlock the hot signer if Frame restarted locked
async function open(ctx, extId, { password }, tag) {
  const tray = await win("Tray");
  // the account panel toggles open/closed on click; open it only if the signer row isn't shown
  for (let i = 0; i < 20 && !/SIGNER Hot/.test(await tray.text()); i++) {
    if (i % 6 === 0) await tray.clickText("Hot Account");
    await sleep(1000);
  }
  await shot(tray, `open-${tag}`);
  log(`  tray (${tag}) before unlock:`, (await tray.text()).slice(-160));
  if (/SIGNER Hot LOCKED/.test(await tray.text())) {
    // expand the signer section (the last "MORE" in the tray), then its "Hot" value opens the
    // signer panel, with the password box, in Dash
    const hot = () => tray.ev(`(()=>{const e=[...document.querySelectorAll("[class*=clusterValueClick]")].find(e=>(e.innerText||"").trim()==="Hot");if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
    let at = null;
    for (let i = 0; i < 4 && !at; i++) {
      // the smallest block whose text starts with "SIGNER" holds the signer's own MORE
      const more = await tray.ev(`(()=>{const mods=[...document.querySelectorAll("body *")].filter(e=>/^SIGNER\\b/.test((e.innerText||"").trim()));const mod=mods[mods.length-1];if(!mod)return null;const m=[...mod.querySelectorAll("*")].filter(e=>(e.innerText||"").trim()==="MORE");const e=m[m.length-1];if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
      if (more) { await sleep(500); await tray.click(...more); }
      await sleep(1000);
      for (let j = 0; j < 6 && !at; j++) { at = await hot(); if (!at) await sleep(500); }
    }
    await shot(tray, `signer-${tag}`);
    if (!at) log("  Hot elements:", JSON.stringify(await tray.ev(`[...document.querySelectorAll("body *")].filter(e=>/^(Hot|LOCKED|LESS)$/.test((e.innerText||"").trim())).map(e=>{const b=e.getBoundingClientRect();return [(e.innerText||"").trim(),e.className.toString().slice(0,40),Math.round(b.x),Math.round(b.y),Math.round(b.width)]})`)));
    if (!at) throw new Error("frame: signer row not found");
    await tray.click(...at);
    const dash = await win("Dash");
    for (let i = 0; i < 20 && !(await dash.ev(`!![...document.querySelectorAll("input[type=password]")].find(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.x>=0&&b.x<400})`)); i++) await sleep(500);
    await shot(dash, `unlock-${tag}`);
    await dash.focusField("input[type=password]", 400); await dash.type(password);
    await dash.clickText("UNLOCK", { maxX: 400 }); await sleep(3000);
    log(`  unlock (${tag}): submitted`);
  }
  await sleep(6000);   // balances, gas monitor, chain connection
  await shot(tray, `home-${tag}`);
  log(`  tray (${tag}):`, (await tray.text()).slice(0, 160));
  return tray;
}

// tray → send.frame.eth (keyboard-driven): token → amount → recipient → review → request
async function sendEth(tray, { to, amount }) {
  // the tray's top-right send button opens send.frame.eth (ENS + content resolve, local serve)
  await tray.ev(`(()=>{scrollTo(0,0);document.querySelectorAll("*").forEach(e=>{if(e.scrollTop)e.scrollTop=0})})()`); await sleep(800);
  const btn = await tray.ev(`(()=>{const c=[...document.querySelectorAll("body *")].filter(e=>{const b=e.getBoundingClientRect();return b.width>20&&b.width<80&&b.height>20&&b.height<80&&b.y>=0&&b.y<80&&b.x>innerWidth/2});const e=c[c.length-1];if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
  log("  send button at", JSON.stringify(btn));
  await tray.click(...(btn || [348, 40]));
  let d = null;
  for (let i = 0; i < 40 && !d; i++) { d = await win("send.frame.eth").catch(() => null); if (!d) await sleep(1000); }
  if (!d) {
    log("  windows:", JSON.stringify((await pages(PORT)).map((p) => [p.title, p.url.slice(0, 90)])));
    await shot(tray, "send-button");
    throw new Error("frame: send.frame.eth never opened");
  }
  await sleep(5000);
  await shot(d, "send-dapp");
  await d.key("Enter"); await sleep(1500);                       // Ether on mainnet is preselected
  await d.type(amount); await d.key("Enter"); await sleep(1500);
  await d.type(to); await sleep(2500); await d.key("Enter"); await sleep(4000);
  await shot(d, "send-review"); log("  dapp:", (await d.text()).slice(0, 200));
  await d.key("Enter"); await sleep(4000);                        // creates the request in Frame
  // Frame's own review: tray → requests → the transaction
  await tray.ev(`(()=>{scrollTo(0,0);document.querySelectorAll("*").forEach(e=>{if(e.scrollTop)e.scrollTop=0})})()`);
  const ready = (t) => /SIGN TRANSACTION|\d+ REQUESTS?/.test(t);
  for (let i = 0; i < 20 && !ready(await tray.text()); i++) {
    if (i === 4 || i === 12) await tray.clickText("Hot Account");   // panel may have closed
    await sleep(1000);
  }
  if (!/SIGN TRANSACTION/.test(await tray.text())) {
    await tray.clickText("^\\d+ REQUESTS?$", { re: true }); await sleep(2000);
    await tray.clickText("Mainnet Transaction"); await sleep(3000);
  }
  await sleep(4000);   // fee + decode settle
  await shot(tray, "sign-screen");
  log("  sign screen:", (await tray.text()).slice(0, 300));
}

module.exports = {
  launch, open, sendEth,
  confirm: async (tray) => { await tray.clickText("SIGN"); log("  confirm: SIGN"); },
};
