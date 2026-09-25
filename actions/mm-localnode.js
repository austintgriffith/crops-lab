// Pre-step for any MetaMask action: point Ethereum at LOCAL_RPC (a LAN node)
// through MetaMask's own UI, close the browser, log 'rpc-edit: done', then run
// actions/<THEN>.js unchanged. That action launches its own browser on the
// same wallet-profile — the restart — so every call it makes runs with the node
// already set. Per-map wrappers: <action>-localnode.js set THEN and require this.
// wallet: metamask
const L = require("./_lib");
const { log, shot } = L;

const THEN = process.env.THEN;
const PASSWORD = process.env.WALLET_PASSWORD || "";
const LOCAL_RPC = process.env.LOCAL_RPC || "http://192.168.68.54:8545";

(async () => {
  L.setPrefix("mml");
  if (!THEN) { console.error("THEN missing"); process.exit(2); }
  const { ctx, extId } = await L.launch();
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  // lock screen or home — whichever mounts first (a snapshot boot is slow)
  await tid("unlock-password").or(tid("network-display")).or(tid("sort-by-networks")).first().waitFor({ timeout: 30000 }).catch(() => {});
  if (await tid("unlock-password").isVisible().catch(() => false)) {
    await tid("unlock-password").fill(PASSWORD);
    await tid("unlock-submit").click();
  }
  await page.waitForTimeout(6000);
  await shot(page, "home");

  const tryClick = async (locs, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const l of locs) {
        if (await l.first().isVisible().catch(() => false)) {
          await l.first().click({ timeout: 5000 }).catch(() => {});
          log(`  rpc ${label}: clicked`);
          await page.waitForTimeout(900);
          return;
        }
      }
      await page.waitForTimeout(300);
    }
    await shot(page, `FAIL-rpc-${label}`);
    throw new Error(`rpc-edit: could not click ${label}`);
  };
  log(`rpc-edit: start -> ${LOCAL_RPC} (then ${THEN})`);
  await tryClick([tid("network-display"), tid("network-selector-button"), tid("sort-by-networks")], "open-networks");
  await tryClick([page.getByText("Manage networks", { exact: true })], "manage-networks");
  await page.waitForTimeout(1500);
  await tryClick([tid("network-list-item-options-button-eip155:1"), tid("network-list-item-options-button-0x1")], "eth-options");
  await tryClick([tid("network-list-item-options-edit"), page.getByText("Edit", { exact: true })], "edit");
  await tryClick([tid("test-add-rpc-drop-down"), page.getByText("Default RPC URL", { exact: false }).locator("xpath=following::button[1]")], "rpc-dropdown");
  await tryClick([page.getByText("Add RPC URL", { exact: true })], "add-rpc");
  await tid("rpc-url-input-test").first().fill(LOCAL_RPC);
  await tid("rpc-name-input-test").first().fill("Local node").catch(() => {});
  await page.waitForTimeout(1500);   // MetaMask probes the URL's chain id here
  await tryClick([page.getByRole("button", { name: /^Add URL$/i })], "add-url", 15000);
  await tryClick([page.getByRole("button", { name: /^Save$/i })], "save", 10000);
  await page.waitForTimeout(2000);
  await shot(page, "rpc-saved");
  await ctx.close();
  await new Promise((r) => setTimeout(r, 3000));
  log(`rpc-edit: done — browser restarted; everything after this is on ${LOCAL_RPC}`);
  require(`./${THEN}.js`);
})().catch((e) => { console.error("mm-localnode failed:", e.message || e); process.exit(1); });
