# How we profile a wallet

The method behind every map on ethereumtransitauthority.com, as run on Oct 2 2026.
Use it to reproduce a capture, add a wallet, or check a claim.

## 1. What a capture is

One user action (send ETH, send a token, swap, approve) in one real wallet, inside a
throwaway macOS VM, recorded from **outside** the VM:

| Layer | Tool | What it gives |
|---|---|---|
| Decrypted HTTPS | mitmproxy on the host, its CA trusted in the guest | every request: host, path, method, body preview + hash, which secret headers were present |
| Ground truth | tcpdump on `bridge100` | pcap of everything that left the VM; flags anything that skipped the proxy |
| The user | Playwright driving the real wallet UI | screenshots per step, a driver log stamped `[t=<epoch>]` to line up with flows |
| The chain | the tx hash, Blockscout, Sourcify | what was actually signed and who it went to |

Output per run: `out/<YYYYMMDD-HHMMSS>-<action>-<wallet>/` with `flows.jsonl`,
`session.pcap`, `driver.log`, `summary.md`, `guest/out/*.png` + `diag-*.txt` (every
`data-testid` and button on screen at each step).

**Deliberately not recorded:** response bodies, query strings (`flow_logger.py` keeps
`path` only). So what a GET *carries* in its query is inferred from the endpoint and
marked that way on the map.

## 2. The images

| Image | Contents |
|---|---|
| `crops-gold` | macOS + Chrome + node + Playwright Chromium. No key, no proxy, no CA. |
| `crops-warm` | gold + MetaMask onboarded with the throwaway seed |
| `crops-warm-<wallet>` | same, for rabby, rainbow, plain, coinbase, phantom |

Every wallet imports the **same throwaway 12-word seed** (`WALLET_MNEMONIC` in
gitignored `.env.crops`), so every wallet controls the same address
`0xd3fd78b46314ffe7b586b8cb3020283ba19b607f` and runs are directly comparable.

Build a warm image once: `WALLET=<wallet> ./lab warm` (runs `actions/setup-<wallet>.js`,
snapshots the result).

## 3. Running a capture

```bash
./lab run <wallet>:<action>          # e.g. rabby:send-token
./lab run <wallet>:<action>+node     # point the wallet at your own node first (needs LAN_RELAY)
```

Actions: `send-eth`, `send-token`, `swap`, `approve-swap`. Wallets with adapters:
`rabby`, `rainbow`, `coinbase`, `phantom`. (MetaMask still uses its older per-action
scripts: `./lab run send-eth`, `swap-metamask`, …)

What a run does: delete the VM → clone the wallet's warm image → boot → start mitmproxy +
tcpdump → ship actions + extension + `.env.crops` → `actions/run.js` → harvest → shut down
→ `summary.md`.

`actions/run.js` is the same for every wallet:

1. launch Chromium with the extension, unlock (`wallet.open`)
2. `+node`: set the wallet's RPC to your node in its own UI (`wallet.setRpc`), restart, unlock again
3. the action (`wallet.sendEth` / `sendToken` / `swap` / `approveSwap`) — drives to the confirm screen
4. **dry (default):** stop there, write `tx.txt` with `MODE: dry`
5. **broadcast** (`SEND_BROADCAST=1` on the command line): `wallet.confirm`, wait for the receipt polling

Per-run knobs from the host shell: `SEND_BROADCAST TOKEN TOKEN_AMOUNT SWAP_TO SWAP_AMOUNT
APPROVE_AMOUNT` (defaults: mUSD 1, USDC, 0.0005 ETH, 1 USDC).

Second VM in parallel (dry runs only): `VM=crops2 GOLD=crops-gold PROXY_PORT=8081 ./lab run …`.

### Rules for real transactions

- Throwaway key only. The user approves real sends per session.
- **Never broadcast two runs at once.** Both wallets read the same nonce and one tx is
  dropped (it happened Oct 2: a Coinbase send was lost to a Phantom send). Run real
  sends one at a time and wait for the account nonce to move before the next.
- Dry run first; read the review screenshot; then broadcast.

## 4. Adding a wallet

1. Get the extension: Chrome Web Store CRX via
   `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D<id>%26uc`,
   unzip into `wallet/<wallet>/`, write `wallet/<wallet>.VERSION` and `.sha256`.
2. **Probe on the host first** (minutes, not VM cycles): a scratch Playwright with
   `--load-extension`, dump visible controls + `data-testid`s at every step, screenshot.
3. Write `actions/setup-<wallet>.js` (import seed → password → home), then
   `WALLET=<wallet> ./lab warm`.
4. Write `actions/wallets/<wallet>.js` exporting `open`, `sendEth`, `sendToken`, `swap`,
   `approveSwap`, `confirm` (and `setRpc` / `prepNode` for own-node runs).
5. Dry run every action, check the review screenshots, then broadcast one at a time.

## 5. From capture to map

1. **Find the tx.** `eth.blockscout.com/api/v2/addresses/<addr>/transactions` (or scan
   recent blocks for `from == addr`). Note `to`, method, value, type (type 4 = EIP-7702).
2. **Name the contracts.** Sourcify `server/v2/contract/1/<addr>?fields=compilation` →
   contract name. Blockscout `addresses/<addr>` as a cross-check. We record the
   contract name, not a guessed company.
3. **Read approvals on chain.** `cast logs … Approval(address,address,uint256)` from the
   account: spender + amount (exact vs 2^256−1 unlimited).
4. **Diff against the wallet's ETH send.** Host+path families (hex and ids collapsed) in the
   new run that the ETH-send run doesn't have = what this action adds. Same for what it
   drops (e.g. no recipient scan in a swap).
5. **Read request bodies** (`req_body_preview`) for anything that might carry user data:
   who gets the recipient, the whole unsigned tx, every address.
6. **Verify an existing route against a run:**
   `python3 enrich/to_route.py out/<run> --route <route.json>` → per step OBSERVED /
   AMBIGUOUS / NOT SEEN, plus hosts no step claims.
7. **Write the route** in `~/ef/strawmapuserflow/data/routes/`: a new wallet gets a full
   `steps` list; an action on a mapped wallet `extends` that wallet's ETH send and adds
   `prepend_steps` (before), `insert_steps` (after a named step — e.g. a post-sign
   submission service) and `drop_steps` (requests this flow never makes). Each step cites
   the run id and the exact request in `provenance.ref`; `status` is `observed` only when
   seen on the wire.
8. Add the view in `data/views/`, `python3 data/build.py`, screenshot the map, then
   `transit/deploy.sh "msg"`.

## 6. Per-wallet notes (Oct 2 2026)

**Rabby 0.94.6** — tapping a token in the send picker opens a detail sheet; press its
Confirm. Swap "To" defaults to USDC; the flip arrow sits at (200,242) in the 400×640 popup.
"Approve and Swap" brings a second sign bar.

**Rainbow 1.6.11** — the swap sell box arrives prefilled with your max balance (clear it).
Flip = `swap-flip-button`, execute = `swap-review-execute`. Its CSP only allows
`127.0.0.1` RPCs, so `+node` runs a local forwarder.

**Coinbase Wallet 3.148.0** — amounts default to USD; press `flip-asset-btn` and type
into `currency-input`. Send/Swap asks for the password again before signing; the
password box sits under the app layer (fill `input[data-testid=unlock-with-password]`
without clicking, force-click `unlock-wallet-button`). The to-asset list needs a search
to show ETH. The Web Store build shows a "3.148.0 QA" corner banner.

**Phantom 26.31.0** — keeps hidden copies of earlier screens in the DOM; match visible
elements only (or click known coordinates). The swap tab opens on Solana (SOL→USDC).
Quotes arrive as a server-sent stream; mitmproxy used to buffer it forever, so
`flow_logger.py` now streams `text/event-stream` responses and logs them on headers.

## 7. Lab fixes made Oct 2

- `lab run` with no `LAN_RELAY` died on an unbound empty array (bash 3.2 + `set -u`).
- `cleanup` / `warm_cleanup` returned non-zero when no relay/tcpdump pid → `set -e`
  exited before the summary, leaving the VM running.
- `lab run <wallet>:<action>` label build used `$(… && …)` → a failed test killed the script silently.
- Warm image names derive from `GOLD`, so a second VM reuses `crops-warm-*`.
- `flow_logger.py`: SSE streaming (above).
- `build.py`: `insert_steps`, `drop_steps` (schema updated).
