// Action: MetaMask, mainnet, send a tiny amount of ETH. THROWAWAY KEY ONLY.
//
// Runs INSIDE the guest under the Aqua session (guest/run-action.sh). Real
// installed Chrome, wallet extension unpacked at ~/lab/wallet/metamask
// (shipped from the host's wallet/ dir at Tier 3), fresh profile every run.
// The network capture AROUND these steps is the product; the UI dance is
// the cost of getting it.
//
// Status: launches Chrome with the extension and a proxy; the import-key /
// approve-popup steps are still to be written (PLAN build-order step 5).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const LAB = path.join(process.env.HOME, "lab");
const OUT = path.join(LAB, "out");
const PROXY = `http://${process.env.HOST_PROXY}:${process.env.PROXY_PORT}`;
const EXT = process.env.WALLET_EXT || path.join(LAB, "wallet", "metamask");
const PK = process.env.WALLET_PK;                 // throwaway, from ~/lab/.env
const RPC = process.env.RPC_URL || "";            // "" = wallet default (that is the point)
const TO = process.env.SEND_TO || "";
const AMOUNT_ETH = process.env.SEND_AMOUNT_ETH || "0.0001";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) {
    console.error(`send-eth: no unpacked extension at ${EXT} — put it in <lab>/wallet/metamask on the host`);
    process.exit(2);
  }
  if (!PK) { console.error("send-eth: WALLET_PK missing in .env.crops"); process.exit(2); }

  const ctx = await chromium.launchPersistentContext(path.join(LAB, "profile"), {
    channel: "chrome",
    headless: false,                              // extensions need a window
    proxy: { server: PROXY },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--disable-quic",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1200, height: 800 },
  });

  // Wait for the extension's service worker so its URL (chrome-extension://<id>) is known.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  const extId = new URL(sw.url()).host;
  console.log("send-eth: extension id", extId);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await page.screenshot({ path: path.join(OUT, "send-eth-00-onboarding.png") });

  // TODO (iterative, PLAN step 5):
  //   1. onboarding -> import with private key PK, set password
  //   2. if RPC set: add custom network RPC (note: that silently disables Smart Transactions)
  //   3. Send -> TO, AMOUNT_ETH -> confirm; capture tx hash from activity
  // Until then: leave the extension up long enough for its background calls
  // (the ones route 01 maps: remote-flags, token lists, price, phishing list…).
  await page.waitForTimeout(30000);
  await page.screenshot({ path: path.join(OUT, "send-eth-99-end.png") });
  await ctx.close();
})().catch((e) => { console.error("send-eth failed:", e); process.exit(1); });
