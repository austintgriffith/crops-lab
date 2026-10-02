// Action: setup-phantom — onboard Phantom (wallet/phantom) once by importing
// the throwaway mnemonic, so the VM can be snapshotted as crops-warm-phantom.
// NOT a capture run. Same key as the other warm images.
// Flow (host probe, Oct 2): onboarding.html → I Already Have a Wallet →
// Import Recovery Phrase → 12 word inputs → Import → Continue (accounts) →
// password ×2 + terms → username step (skipped; the wallet is usable).
// wallet: phantom
const L = require("./_lib");
const { log, shot, dumpTestIds } = L;
const WORDS = (process.env.WALLET_MNEMONIC || "").trim().split(/\s+/);
const PASSWORD = process.env.WALLET_PASSWORD || "";

(async () => {
  L.setPrefix("sph");
  if (WORDS.length < 12 || !PASSWORD) { console.error("WALLET_MNEMONIC/WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true });
  log("setup-phantom: extension id", extId);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/onboarding.html`, { waitUntil: "load" });
  const t = (id) => page.getByTestId(id);
  await page.getByText("I Already Have a Wallet").click({ timeout: 30000 });
  await page.getByRole("button", { name: /Import Recovery Phrase/ }).click();
  for (let i = 0; i < 12; i++) await t(`secret-recovery-phrase-word-input-${i}`).fill(WORDS[i]);
  await shot(page, "seed");
  await t("onboarding-form-submit-button").click();
  await page.getByRole("button", { name: "View Accounts" }).waitFor({ timeout: 60000 });   // account discovery
  await t("onboarding-form-submit-button").click();
  await t("onboarding-form-password-input").fill(PASSWORD, { timeout: 30000 });
  await t("onboarding-form-confirm-password-input").fill(PASSWORD);
  await t("onboarding-form-terms-of-service-checkbox").click({ force: true }).catch(() => {});
  await t("onboarding-form-submit-button").click();
  await page.waitForTimeout(4000);
  await shot(page, "after-password");
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await pop.getByTestId("portfolio-balance").waitFor({ timeout: 60000 });
  await shot(pop, "home"); await dumpTestIds(pop, "home");
  log("setup-phantom: done — snapshot to crops-warm-phantom now");
  await ctx.close();
})().catch((e) => { console.error("setup-phantom FAILED:", e.message); process.exit(1); });
