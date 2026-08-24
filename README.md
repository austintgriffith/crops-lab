# CROPS Lab

Runs a real wallet + browser + dapp inside a throwaway **macOS** VM and records every
byte it sends, **decrypted**, from *outside* the guest. One command per user action;
the output is a ledger of who each request went to and what it carried.

Output: `out/<run>/` (pcap + decrypted flows + `summary.md`) → `enrich/to_ledger.py`
→ the transit-map `ledger.tsv`.

Design notes: [PLAN.md](PLAN.md). Cross-route results: [docs/FINDINGS.md](docs/FINDINGS.md).
Substrate: [clawd-containers](https://github.com/clawdbotatg/clawd-containers)
(`~/clawd/clawd-containers`, read its `CLAUDE.md`) — tart macOS VMs via `cont`. Reused, not rebuilt.

## How it works

Capture happens on the **host, outside the guest**, so the wallet can't hide anything:

- **mitmproxy** on the host, its CA trusted in the guest System keychain → decrypts every HTTPS body (what each request *carries*).
- **tcpdump** on `bridge100` → ground-truth pcap of what actually left the VM, outside the guest's control. This is the auditor: it catches anything that skipped the proxy (BYPASS), any HTTP/3 that got past the QUIC kill (QUIC LEAK), and says **NO PCAP** loudly if it couldn't run.
- **Playwright** drives the real browser + MetaMask through the actual UI.

Two baked images, cloned per run so every capture starts from an identical clean guest:

- **`crops-gold`** — macOS + brew + Chrome + node + Playwright's Chromium. Identity-free: no key, no proxy, no CA.
- **`crops-warm`** — gold + MetaMask 13.45 onboarded + a throwaway wallet imported. Identity-bearing on purpose; local only, never pushed.

## Use

```bash
./lab doctor              # what's missing, one line each, with the fix
./lab bake                # once: base image -> crops-gold (Tier 1+2, identity-free)
./lab warm                # once: gold -> crops-warm (onboard MetaMask + import throwaway key)
./lab run smoke           # proves decrypt end to end: example.com + one JSON-RPC POST
./lab run send-eth        # route 01: MetaMask ETH send, mainnet
./lab run send-ens        # route 02: ETH send to an ENS name
./lab run deposit-aave    # route 03: supply ETH to Aave V3 (full dapp flow)
./lab summarize <run>     # re-audit an existing capture
./lab gui | shell | status | down | rm
```

`run` = delete VM → clone the right base (`crops-warm` for wallet actions, else `crops-gold`)
→ boot → start mitmproxy + tcpdump on the host → ship Tier 3 over one tar stream → run the
action → harvest guest files → graceful shutdown → `summary.md`. Identical clean guest every time.

**Every send/deposit is DRY by default** — it drives all the way to MetaMask's confirmation
screen (where the tx is built and simulated, firing most of the interesting traffic) and stops
without broadcasting. Set the action's broadcast flag (`SEND_BROADCAST=1` / `AAVE_BROADCAST=1`)
in `.env.crops` only to actually submit.

## The wallet

`lab warm` onboards a wallet once and snapshots it, so runs only have to *unlock*, never
re-onboard. The wallet holds a **throwaway 12-word mnemonic** generated on the host
(`WALLET_MNEMONIC` in gitignored `.env.crops`); fund its account-0 address to run real sends.
Never a real seed.

**Multiple wallets** (added Aug 23). `WALLET=<name>` picks which unpacked extension in
`wallet/<name>/` to onboard and snapshot:
- `WALLET=metamask lab warm` → `crops-warm` (default).
- `WALLET=rainbow  lab warm` → `crops-warm-rainbow`.
The **same mnemonic → same address** across wallets, so a send is directly comparable. An
action declares its wallet with a `// wallet: <name>` line near the top; `lab run <action>`
reads it and auto-clones the matching warm image. Onboarding drivers are `actions/setup-<name>.js`;
shared Playwright helpers live in `actions/_lib.js` (every log line stamped `[t=<epoch>]` so
driver milestones align with `flows.jsonl` `"t"`). To add a wallet: drop its unpacked extension
in `wallet/<name>/`, write `setup-<name>.js` + `send-eth-<name>.js`, `WALLET=<name> lab warm`, run.

## Routes

| route | action | what it maps | rows |
|---|---|---|---:|
| 01 | `send-eth` | plain ETH send, MetaMask, mainnet defaults | 84 |
| 02 | `send-ens` | ETH send to an ENS name (adds on-chain name resolution) | 84 |
| 03 | `deposit-aave` | supply ETH to Aave V3 — connect, read, build supply tx | 303 |
| 04 | `send-eth-rainbow` | plain ETH send, **Rainbow** ext 1.6.11 (`WALLET=rainbow`) | 90 flows / 16 hosts |
| 05 | `send-eth-ambire` | plain ETH send, **Ambire** ext 6.18.7 (`WALLET=ambire`) | onboarding blocked — see note |
| 06 | `swap-uniswap` | **swap** ETH→USDC on app.uniswap.org, MetaMask connected | 1212 flows / 71 hosts (dry) |

**Uniswap swap note.** `lab run swap-uniswap` (dry, `// wallet: metamask`) loads app.uniswap.org, picks ETH→USDC, and captures the quote. It cleanly captures the novel swap surface: Uniswap **quotes you anonymously** (a real price before any wallet connects), the `entry-gateway.backend-prod.api.uniswap.org` gRPC API, `interface.gateway.uniswap.org`, the metrics gateway, and Privy embedded-wallet auth. The **connect-to-MetaMask step is unreliable** (injected-provider connect in Playwright/Chromium is finicky — the wallet often stays unconnected), so the *connected swap-tx* leg (calldata + MetaMask simulation) usually doesn't capture; it's code-traced instead (`../strawmapuserflow/wallets/uniswap-swap-trace.md`, map U1). Deliberately never auto-broadcasts a trade (`SWAP_BROADCAST` exists but auto-executing a swap is out of scope). To finish the connected leg: fix the injected-MetaMask connect (click the wallet-modal option row so `eth_requestAccounts` fires), or run it against a live profile.

**Ambire onboarding note.** `WALLET=ambire lab warm` gets through seed import + keystore password but stalls at "Loading accounts → Something went wrong with deriving the accounts." Ambire is a **smart-account** wallet: creating or restoring one requires a live network call to Ambire's relayer/RPC to derive the counterfactual account address — it cannot onboard from local key derivation alone the way MetaMask/Rainbow do. So route 05 has a code trace (`../strawmapuserflow/wallets/ambire-ext-trace.md`, map AB1) but no capture yet. Driver: `actions/setup-ambire.js`. To finish: drive onboarding via `lab gui` (VNC) and watch whether derivation completes, or capture from a live profile.

The headline: a plain send talks to ~11 parties; supplying to Aave talks to ~23 — the dapp
pulls in its own APIs, a simulation provider, WalletConnect, four analytics vendors, two
fiat on-ramps, and a calldata decoder. Full breakdown in [docs/FINDINGS.md](docs/FINDINGS.md).

## Layout

| path | role |
|---|---|
| `lab` | host CLI. `cmd_<verb>` + `main` dispatch, same shape as `cont` |
| `guest/provision-crops.sh` | in-guest provisioner. Sources clawd-containers' `provision.sh` (Tier 1), adds node + Playwright + bundled Chromium + Chrome policy (Tier 2), then per-run CA/proxy/actions/secrets (Tier 3). `CROPS_FAST=1` skips 1+2; `CROPS_BAKE=1` refuses secrets |
| `guest/run-action.sh` | in-guest: loads `.env` + `run.env`, runs `node actions/<name>.js` (already in the Aqua session via the agent) |
| `actions/smoke.js` | decrypt proof — real Chrome, no wallet |
| `actions/setup-wallet.js` | onboards MetaMask by importing the throwaway mnemonic (run by `lab warm`) |
| `actions/send-eth.js` · `send-ens.js` · `deposit-aave.js` | the routes. Bundled Chromium (real Chrome 151 blocks `--load-extension`) |
| `capture/flow_logger.py` | mitmproxy addon → `flows.jsonl` (who + what it carries; secret headers as present-only, never stored) + `sni.log` |
| `capture/summarize.py` | the audit: decrypted hosts · OPAQUE SNIs · pcap BYPASS / QUIC LEAK · or "NO PCAP" said loudly |
| `enrich/to_ledger.py` | `flows.jsonl` → 16-column `ledger.tsv` (matches `../strawmapuserflow/routes/*/ledger.tsv`). `PARTIES` maps host → owner; unknown owners flagged, never guessed |
| `gold/manifest.txt` | written by `bake`: macOS build, Chrome, node, Playwright versions — the pins |
| `legacy/` | the first scaffold. Kept for diff; do not run |

Not committed: `ca/` (mitm CA), `wallet/` (unpacked extension), `.env.crops`, `.seed.tmp`, `out/`.

## Rules, each with its reason

- **Gold is identity-free.** No key, no proxy, no CA in `crops-gold`. Bake refuses `.env.crops`. clawd-containers baked an identity once and every clone ran as it. (`crops-warm` is deliberately identity-bearing and stays local.)
- **Tier 3 every run, never re-provision.** Clone the base + sync volatile state ≈ 10 s. Re-provisioning the 33 GB base per run is what the old `run.sh` did.
- **Wallet actions use Playwright's bundled Chromium, not `channel:'chrome'`.** Google Chrome 128+ (verified dead on Chrome 151) blocks `--load-extension` from the command line, so an unpacked MetaMask can't load in real Chrome. Chromium shares Chrome's network stack, so the traffic is identical; `smoke` still uses real Chrome.
- **Transport is `tart exec`, not ssh.** The Tart Guest Agent runs commands as admin *inside the Aqua session* (headed Chrome just works) and carries a tar stream on stdin. It needs no network path — a launchd-spawned host process is denied macOS Local Network access and gets `No route to host` on bridge100 while the guest is up; ssh from here never connects.
- **Graceful `shutdown -h` before `tart stop`.** A hard stop has rolled back fresh writes.
- **awk over `tart list`, never `grep -q`.** pipefail + early exit SIGPIPEs tart; a running VM reads as stopped.
- **`timeout` is a python shim.** macOS ships none.
- **We do not call `cont provision`.** It ships the host's Claude OAuth login into the guest. A profiler VM carries no login but the throwaway wallet.
- **The pcap is the auditor.** Proxy output alone cannot prove the guest sent nothing else.
- **QUIC is killed twice.** Chrome policy `QuicAllowed=false` in gold + `--disable-quic` per launch. macOS OS traffic (Apple 17.0.0.0/8 and named `*.apple.com`) is bucketed as noise, separate from real bypass.
- **Sends are DRY by default; broadcast needs an explicit flag.** The final Confirm is an irreversible transfer.
- **Never a real seed.** The mnemonic is throwaway, Tier 3, wiped with the VM.

## Host prerequisites

`tart` ≥ 2.20 (`tart exec`), `cont`, `mitmproxy` (`brew install mitmproxy`), the base image
(`cont pull`), `cast` (foundry, for keygen/nonce checks), and one sudoers line so tcpdump can
run unattended:

```
echo 'clawd ALL=(root) NOPASSWD: /usr/sbin/tcpdump' | sudo tee /etc/sudoers.d/crops-tcpdump
```

tcpdump runs with `-Z clawd` — root only to open the device, then drops to us so `lab` can stop it.

## Status

**Validated end to end.** All three routes capture cleanly (0 pinned/opaque SNIs, no QUIC leaks).
Route 01 was broadcast for real on mainnet (tx `0xf6bd…92c1`); 02 and 03 stop at the confirm
screen. `to_ledger.py` output for route 01 matches the hand-traced
`../strawmapuserflow/routes/01-eth-send-metamask/ledger.tsv` (15/18 hosts; the 3 gaps are all
explained in FINDINGS). The live captures are *richer* than the hand-drawn maps.

See [docs/FINDINGS.md](docs/FINDINGS.md) for the per-route breakdown and the party comparison.
