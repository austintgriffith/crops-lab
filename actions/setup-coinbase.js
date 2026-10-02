// Action: setup-coinbase — onboard Coinbase Wallet (wallet/coinbase) once by
// importing the throwaway mnemonic, so the VM can be snapshotted as
// crops-warm-coinbase. NOT a capture run. Same key as the other warm images.
// Flow (host probe, Oct 2): index.html → Import a Wallet → recovery phrase →
// Acknowledge warning → secret-input → password ×2 + terms → portfolio.
// wallet: coinbase
const L = require("./_lib");
const { log, shot, dumpTestIds } = L;
const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";

(async () => {
  L.setPrefix("scb");
  if (MNEMONIC.split(" ").length < 12 || !PASSWORD) { console.error("WALLET_MNEMONIC/WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true });
  log("setup-coinbase: extension id", extId);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/index.html`, { waitUntil: "load" });
  const t = (id) => page.getByTestId(id);
  await t("btn-import-existing-wallet").click({ timeout: 30000 });
  await t("btn-import-recovery-phrase").click();
  await page.getByRole("button", { name: "Acknowledge" }).click({ timeout: 10000 }).catch(() => {});
  await t("secret-input").fill(MNEMONIC);
  await shot(page, "seed");
  await t("btn-import-wallet").click();
  await t("setPassword").fill(PASSWORD, { timeout: 30000 });
  await t("setPasswordVerify").fill(PASSWORD);
  await page.locator("input[type=checkbox]").check({ force: true }).catch(() => {});
  await t("btn-password-continue").click();
  await t("wallet-balance").waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  await shot(page, "home"); await dumpTestIds(page, "home");
  log("setup-coinbase: done — snapshot to crops-warm-coinbase now");
  await ctx.close();
})().catch((e) => { console.error("setup-coinbase FAILED:", e.message); process.exit(1); });
