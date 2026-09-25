// Action: setup-rabby — onboard the Rabby extension (wallet/rabby, 0.94.6)
// once by importing the throwaway mnemonic, so the VM can be snapshotted as
// crops-warm-rabby. NOT a capture run. Same key as the MetaMask/Rainbow warm
// images → same address → a directly comparable send across wallets.
//
// Flow (worked out on the host, Sep 24): first run opens index.html#/new-user/guide
//   "I already have an address" -> "Seed Phrase or Private Key"
//   -> 12 word inputs (input.mnemonics-input — type=password, which is why the
//      Aug attempt's grid check never saw them); insertText the whole phrase
//      into word 1 and Rabby splits it -> Next
//   -> set password (+ agree) -> Confirm -> #/new-user/success
// wallet: rabby
const L = require("./_lib");
const { log, shot, dumpTestIds } = L;

const MNEMONIC = (process.env.WALLET_MNEMONIC || "").trim().replace(/\s+/g, " ");
const PASSWORD = process.env.WALLET_PASSWORD || "";
const ADDR = (process.env.WALLET_ADDR || "").toLowerCase();

(async () => {
  L.setPrefix("srb");
  if (MNEMONIC.split(" ").length < 12) { console.error("WALLET_MNEMONIC missing/short"); process.exit(2); }
  if (!PASSWORD) { console.error("WALLET_PASSWORD missing"); process.exit(2); }
  const { ctx, extId } = await L.launch({ fresh: true });
  log("setup-rabby: extension id", extId);

  let page = ctx.pages().find((p) => p.url().includes(`${extId}/index.html`));
  if (!page) { page = await ctx.newPage(); await page.goto(`chrome-extension://${extId}/index.html#/new-user/guide`); }
  await page.bringToFront();
  await page.getByText("I already have an address").waitFor({ timeout: 30000 });
  await shot(page, "guide");
  await page.getByText("I already have an address").click();
  await page.getByText(/Seed Phrase/i).first().click();
  const words = page.locator("input.mnemonics-input");
  await words.first().waitFor({ timeout: 15000 });
  await words.first().click();
  await page.keyboard.insertText(MNEMONIC);
  await page.waitForTimeout(800);
  const filled = (await words.evaluateAll((es) => es.map((e) => e.value))).filter(Boolean).length;
  log("  seed words filled:", filled);
  if (filled < 12) {
    const w = MNEMONIC.split(" ");
    for (let i = 0; i < 12; i++) { await words.nth(i).click(); await words.nth(i).pressSequentially(w[i], { delay: 20 }); }
  }
  await shot(page, "seed-filled");
  await page.getByRole("button", { name: /^Next$/ }).click();

  const pw = page.locator("input[type=password]:not(.mnemonics-input)");
  await pw.first().waitFor({ timeout: 15000 });
  await pw.nth(0).fill(PASSWORD); await pw.nth(1).fill(PASSWORD);
  const agree = page.locator("input[type=checkbox]");
  if ((await agree.count()) && !(await agree.first().isChecked())) await agree.first().check().catch(() => {});
  await shot(page, "password");
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForURL(/new-user\/success/, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot(page, "success"); await dumpTestIds(page, "success");

  const body = ((await page.textContent("body").catch(() => "")) || "").toLowerCase();
  if (ADDR && !body.includes(ADDR.slice(0, 8))) throw new Error("imported, but WALLET_ADDR not shown on the success page");
  log(`  OK address ${ADDR.slice(0, 8)}… imported`);
  log("setup-rabby: done — snapshot to crops-warm-rabby now");
  await ctx.close();
})().catch((e) => { console.error("setup-rabby FAILED:", e.message); process.exit(1); });
