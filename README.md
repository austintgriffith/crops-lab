# CROPS Lab

Runs a wallet + browser + dapp inside a throwaway **macOS** VM and records every
byte in and out, **decrypted**, from outside the guest. Output: `out/<run>/` →
`enrich/to_ledger.py` → the transit-map `ledger.tsv`.

Design: [PLAN.md](PLAN.md). Substrate: [clawd-containers](https://github.com/clawdbotatg/clawd-containers)
(`~/clawd/clawd-containers`, read its `CLAUDE.md`) — tart VMs via `cont`. Reused, not rebuilt.

## Use

```bash
./lab doctor            # what's missing, one line each, with the fix
./lab bake              # once: base image -> crops-gold (Tier 1+2, identity-free)
./lab run smoke         # proves decrypt end to end: example.com + one JSON-RPC POST
./lab run send-eth      # MetaMask send (needs wallet/metamask + .env.crops)
./lab summarize <run>   # re-audit an existing capture
./lab gui | shell | status | down | rm
```

`run` = delete VM → `tart clone crops-gold` → boot → start mitmproxy + tcpdump on
the host → ship Tier 3 over one tar stream → action → harvest guest files →
graceful shutdown → `summary.md`. ~1 min of overhead per run, identical clean
guest every time.

## Layout

| path | role |
|---|---|
| `lab` | host CLI. `cmd_<verb>` + `main` dispatch, same shape as `cont` |
| `guest/provision-crops.sh` | in-guest provisioner. Sources clawd-containers' `provision.sh` (Tier 1), adds node/playwright/Chrome policy (Tier 2), then per-run CA/proxy/actions/secrets (Tier 3). `CROPS_FAST=1` skips 1+2; `CROPS_BAKE=1` refuses secrets |
| `guest/run-action.sh` | in-guest: loads `.env` + `run.env`, runs `node actions/<name>.js` (already in the Aqua session via the agent) |
| `actions/*.js` | Playwright drivers, real installed Chrome (`channel:'chrome'`). `smoke` works; `send-eth` launches MetaMask, key-import/approve still TODO |
| `capture/flow_logger.py` | mitmproxy addon → `flows.jsonl` (who + what it carries; secret headers as present, never stored) + `sni.log` |
| `capture/summarize.py` | the audit: decrypted hosts · OPAQUE SNIs · pcap BYPASS / QUIC LEAK · or "NO PCAP" said loudly |
| `enrich/to_ledger.py` | `flows.jsonl` → 16-column `ledger.tsv` (matches `../strawmapuserflow/routes/*/ledger.tsv`) |
| `gold/manifest.txt` | written by `bake`: macOS build, Chrome, node, playwright versions — the pins |
| `legacy/` | the first scaffold (`run.sh`, `provision-crops.sh`). Kept for diff; do not run |

Not committed: `ca/` (mitm CA, key + cert), `wallet/<name>/` (unpacked extension), `.env.crops`, `out/`.

## Rules, each with its reason

- **Gold is identity-free.** No key, no proxy, no CA in `crops-gold`. Bake refuses `.env.crops`. clawd-containers baked an identity once and every clone ran as it.
- **Tier 3 every run, never re-provision.** Clone gold + sync volatile state ≈ 10 s. Re-provisioning from the 33 GB base per run is what the old `run.sh` did.
- **Transport is `tart exec`, not ssh.** The Tart Guest Agent (in every cirruslabs image) runs commands as admin *inside the Aqua session* and carries a tar stream on stdin. It also needs no network path: a launchd-spawned host process (this harness) is denied macOS Local Network access and gets `No route to host` on bridge100 while the guest is up — ssh from here never connects. The agent appears ~5–7 min after a fresh clone's first boot; `lab` waits up to `AGENT_WAIT` (600 s).
- **One tar stream, 3 retries.** Files go in one `tar | tart exec -i` pipe.
- **Graceful `shutdown -h` before `tart stop`.** A hard stop has rolled back fresh writes.
- **awk over `tart list`, never `grep -q`.** pipefail + early exit SIGPIPEs tart; a running VM reads as stopped.
- **`timeout` is a python shim.** macOS ships none.
- **We do not call `cont provision`.** It ships the host's Claude OAuth login into the guest and records custody. A profiler VM carries no login but the throwaway one.
- **The pcap is the auditor.** Proxy output alone cannot prove the guest sent nothing else. `summarize` flags direct TLS (BYPASS), udp/443 (QUIC LEAK), and says NO PCAP when tcpdump could not run.
- **QUIC is killed twice.** Chrome policy `QuicAllowed=false` in gold + `--disable-quic` per launch.
- **Proxy is set twice.** System proxy on every network service (native apps, extension workers) + Chrome policy `ProxyMode=fixed_servers`.
- **Never a real seed.** `WALLET_PK` is dust, Tier 3, wiped with the VM.

## Host prerequisites

`tart` ≥ 2.20 (`tart exec`), `cont`, `mitmproxy` (`brew install mitmproxy`), the base image
(`cont pull`), and one sudoers line so tcpdump can run unattended:

```
echo 'clawd ALL=(root) NOPASSWD: /usr/sbin/tcpdump' | sudo tee /etc/sudoers.d/crops-tcpdump
```

tcpdump runs with `-Z clawd` — root only to open the device, then drops to us so `lab` can stop it.

## Status

`lab doctor` / `bake` / `run smoke` all pass. Smoke proves the pipeline: a live
`eth_blockNumber` POST is captured **decrypted** in `flows.jsonl`, the pcap
confirms it, and Apple/OS noise is bucketed away from real proxy bypass.

Next: unpack a pinned MetaMask build into `wallet/metamask/`, finish
`actions/send-eth.js` (import key → send → approve), run it, diff
`to_ledger.py` output against the hand-traced
`../strawmapuserflow/routes/01-eth-send-metamask/ledger.tsv`.
