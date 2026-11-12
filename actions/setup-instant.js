// Action: setup-instant — make an Instant Wallet (instantwallet.io) once, so the
// VM can be snapshotted as crops-warm-instant. Runs through the proxy: the
// onboarding is captured too.
//
// No seed to import: the wallet's key is a passkey. The virtual authenticator
// makes one, and it is saved inside the guest profile for later runs. It never
// leaves the VM image, so rebuilding the image makes a NEW wallet: empty the
// old one first.
//
// Writes out/instant-address.txt (the address to fund).
// wallet: instant
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const W = require("./wallets/instant");
const { log, shot, dumpTestIds } = L;

(async () => {
  L.setPrefix("si");
  const { ctx } = await W.launch({ fresh: true });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const { cdp, authenticatorId } = await W.authenticator(ctx, page);
  await page.goto(W.SITE, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await shot(page, "entry"); await dumpTestIds(page, "entry");

  await page.getByRole("button", { name: "Create wallet" }).click();
  log("  click create");
  await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);
  await shot(page, "home"); await dumpTestIds(page, "home");

  await W.saveCredential(cdp, authenticatorId);
  const addr = await W.address(page);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) throw new Error(`no wallet address after create (got ${addr})`);
  fs.writeFileSync(path.join(L.OUT, "instant-address.txt"), addr + "\n");
  log(`setup-instant: wallet ${addr} — profile at ${L.PROFILE}`);
  await ctx.close();
})().catch((e) => { console.error("setup-instant failed:", e.message || e); process.exit(1); });
