// Action: smoke — proves the capture path end to end, no wallet involved.
// Real Chrome in the guest (channel:'chrome'), system proxy + explicit proxy
// -> host mitmproxy, CA trusted. Hits one HTTPS page and one JSON-RPC POST
// whose body the host must be able to read in flows.jsonl. If it can't,
// nothing downstream is worth running.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(LAB, "profile"), {
    channel: "chrome",
    headless: false,
    proxy: { server: PROXY },
    args: ["--disable-quic", "--no-first-run", "--no-default-browser-check"],
    viewport: { width: 1200, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto("https://example.com/", { waitUntil: "load", timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, "smoke-example.png") });

  // A POST with a JSON body, made from INSIDE the page (Chrome's fetch), so
  // it goes through the proxy and trusts the system-keychain mitm CA. Its
  // decrypted preview must show up in flows.jsonl (req_body_preview) — that
  // is the assertion the host makes. (page.request.* uses Node's own TLS,
  // which ignores the system CA and would reject the mitm cert.)
  const out = await page.evaluate(async (rpc) => {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    return { status: r.status, body: await r.text() };
  }, RPC);
  fs.writeFileSync(path.join(OUT, "smoke-rpc.json"), out.body);
  console.log("smoke: example.com ok; rpc", out.status, out.body.slice(0, 120));

  await page.waitForTimeout(3000);
  await ctx.close();
})().catch((e) => { console.error("smoke failed:", e); process.exit(1); });
