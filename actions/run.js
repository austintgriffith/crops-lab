// Generic action runner: one skeleton for every wallet × action.
//   lab run <wallet>:<action>        e.g. lab run rabby:send-token
//   lab run <wallet>:<action>+node   same, with Ethereum pointed at your node first
// Wallet-specific UI lives in wallets/<wallet>.js; this file only does what
// every run shares: launch, unlock, optional node switch + restart, the
// action, then stop at review (DRY) or confirm (BROADCAST).
//
// env: WALLET, DO (action), NODE=1, LOCAL_RPC, SEND_TO/WALLET_ADDR,
//      SEND_AMOUNT_ETH, TOKEN, TOKEN_AMOUNT, SEND_BROADCAST=1
// wallet-profile (marker: lab clones the warm image for this file)
const fs = require("fs");
const path = require("path");
const L = require("./_lib");
const { log, shot, dumpTestIds } = L;

const WALLET = process.env.WALLET;
const DO = process.env.DO;
const NODE = process.env.NODE === "1";
const BROADCAST = process.env.SEND_BROADCAST === "1";
const args = {
  password: process.env.WALLET_PASSWORD || "",
  to: process.env.SEND_TO || process.env.WALLET_ADDR || "",
  amount: process.env.SEND_AMOUNT_ETH || "0.0002",
  token: process.env.TOKEN || "mUSD",
  tokenAmount: process.env.TOKEN_AMOUNT || "1",
  swapTo: process.env.SWAP_TO || "USDC",
  swapAmount: process.env.SWAP_AMOUNT || "0.0005",
  approveAmount: process.env.APPROVE_AMOUNT || "1",
  localRpc: process.env.LOCAL_RPC || "http://192.168.68.54:8545",
};
// action name → adapter method
const METHOD = { "send-eth": "sendEth", "send-token": "sendToken", "swap": "swap", "approve-swap": "approveSwap" };

(async () => {
  const W = require(`./wallets/${WALLET}.js`);
  const method = METHOD[DO];
  if (!method || !W[method]) {
    console.error(`${WALLET} has no ${DO} (has: ${Object.keys(METHOD).filter((k) => W[METHOD[k]]).join(", ")})`);
    process.exit(2);
  }
  if (!args.to) { console.error("no recipient (SEND_TO or WALLET_ADDR)"); process.exit(2); }
  L.setPrefix(`${WALLET}-${DO}${NODE ? "-node" : ""}`);
  const tag = `${WALLET}:${DO}${NODE ? "+node" : ""}`;

  if (NODE && W.prepNode) args.localRpc = W.prepNode(args.localRpc);
  // desktop wallets (Frame) bring their own launcher
  const launch = W.launch || L.launch;
  let { ctx, extId } = await launch();
  log(`${tag}: extension id ${extId}`);
  let page = await W.open(ctx, extId, args, "start");

  if (NODE) {
    if (!W.setRpc) throw new Error(`${WALLET} has no setRpc`);
    log(`rpc-edit: start -> ${args.localRpc}`);
    await W.setRpc(page, extId, args.localRpc);
    // restart so startup calls and the unlock already run with the node set
    await ctx.close();
    await new Promise((r) => setTimeout(r, 3000));
    log(`rpc-edit: done — browser restarted; everything after this is on ${args.localRpc}`);
    ({ ctx } = await launch());
    page = await W.open(ctx, extId, args, "node");
  }

  await W[method](page, args, extId);
  await shot(page, "review"); await dumpTestIds(page, "review");

  const detail = `wallet: ${WALLET}\naction: ${DO}\nto: ${args.to}\namount_eth: ${args.amount}\ntoken: ${args.token} ${args.tokenAmount}\nnode: ${NODE ? args.localRpc : "wallet default"}\n`;
  if (!BROADCAST) {
    log(`${tag}: DRY run — stopped at review, NOT broadcasting (SEND_BROADCAST=1 to submit)`);
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: dry (no broadcast)\n${detail}`);
  } else {
    await W.confirm(page, args, extId);
    await new Promise((r) => setTimeout(r, 15000));   // broadcast + first status polls
    await shot(page, "after-confirm"); await dumpTestIds(page, "after-confirm");
    fs.writeFileSync(path.join(L.OUT, "tx.txt"), `MODE: broadcast\n${detail}(txhash: see flows.jsonl)\n`);
    await new Promise((r) => setTimeout(r, 20000));   // receipt polling
    await shot(page, "done");
    log(`${tag}: submitted`);
  }
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error(`run ${WALLET}:${DO} failed:`, e.message || e); process.exit(1); });
