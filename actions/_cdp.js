// Minimal Chrome DevTools Protocol driver for Electron apps Playwright can't attach to
// (Frame: connectOverCDP fails on Browser.setDownloadBehavior; _electron.launch hangs).
// The app must run with --remote-debugging-port=<port>. Coordinates are CSS pixels.
// Never returns input values (seed/password fields).
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pages(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");
}

async function attach(port, match) {
  const t = (await pages(port)).find((p) => p.url.includes(match) || p.title.toLowerCase() === match.toLowerCase());
  if (!t) throw new Error(`no window "${match}"`);
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const wait = new Map();
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  // centre of the deepest visible element whose text is exactly `text` (or matches a RegExp source)
  const find = (text, { re = false, minX = -1, maxX = 1e9 } = {}) => ev(`(()=>{
    const ok=(s)=>${re ? `new RegExp(${JSON.stringify(text)}).test(s)` : `s===${JSON.stringify(text)}`};
    const m=[...document.querySelectorAll("body *")].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.x>=${minX}&&b.x<${maxX}&&ok((e.innerText||e.placeholder||"").trim())});
    const e=m[m.length-1]; if(!e) return null; e.scrollIntoView({block:"center"}); const b=e.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2];})()`);
  const P = {
    ev, send, close: () => ws.close(),
    text: async () => (await ev("document.body.innerText")).replace(/\s+/g, " "),
    shot: async (f) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(f, Buffer.from(r.result.data, "base64")); },
    click: async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); },
    find,
    clickText: async (text, opts) => {
      let at = null;
      for (let i = 0; i < 20 && !at; i++) { at = await find(text, opts); if (!at) await sleep(500); }
      if (!at) throw new Error(`no element "${text}"`);
      await P.click(...at);
    },
    // first visible input/textarea inside the window's horizontal bounds (slide panels sit off-screen)
    focusField: async (sel = "input,textarea", maxX = 1e9) => {
      const at = await ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.x>=0&&b.x<${maxX}});if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
      if (!at) throw new Error(`no field ${sel}`);
      await P.click(...at);
    },
    type: (text) => send("Input.insertText", { text }),
    key: async (key) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 0 }); },
  };
  return P;
}

module.exports = { pages, attach, sleep };
