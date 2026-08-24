# CROPS Lab — network & isolation profiler

> **Status: built and validated.** Three routes capture end to end (send, ENS send, Aave supply).
> This file is the design rationale; see [README.md](README.md) for use and
> [docs/FINDINGS.md](docs/FINDINGS.md) for results.

Sibling to the mapping system (`../strawmapuserflow`, site `../eta-public`). Its job: run a real wallet + browser + dapp inside a throwaway **macOS** VM, perform one action, and record **every byte in and out** — decrypted — then reduce that to the `ledger.tsv` the transit maps read. Maps are downstream; the lab's output is a JSON/TSV artifact.

macOS because that's how people actually use crypto — same OS, same wallets, same apps. The VM is the CROPS boundary made literal; every distinct egress endpoint is a candidate leak / block / lie point, the exact thing the maps mark.

---

## Substrate: tart + `cont` (already built)

`~/clawd/clawd-containers` runs macOS-on-macOS VMs on Apple Silicon via [tart](https://tart.run), wrapped by the `cont` CLI. We reuse its VM verbs (`up/down/rm/ssh/ip/open/snapshot`) and copy its operating patterns; we do **not** use `cont provision` (it injects the host's Claude login) and we do not rebuild anything. The host CLI is `./lab` — see README "Rules, each with its reason".

- `lab bake` — `tart clone` the base → provision Tier 1+2 → graceful stop → snapshot `crops-gold`. Identity-free.
- `lab run <action>` — `tart clone crops-gold crops` → boot → sync only Tier 3 (CA, proxy → host, actions, throwaway env) → capture. **Identical clean guest per run, ~10 s of sync.**
- `lab gui` → `cont open` (VNC; `tart run` renders no window on Tahoe). Chrome is in the gold via clawd-containers' `provision.sh`.

## Why capture from the host, not inside the guest

A tart VM's traffic egresses through a **host-side vmnet/bridge interface**. We tap it from the host — **outside the guest**. That's a stronger boundary than a proxy inside the box: the guest (wallet, dapp, malware) can't see, disable, or route around a tap it isn't part of. "In and out" is measured at the wall, not by a cooperating tenant.

```
   host (Mac mini)                              guest VM (macOS, tart)
   ┌───────────────────────────────┐           ┌──────────────────────────┐
   │ mitmproxy :8080  ─decrypts─┐   │◀─proxy────│ Chrome + wallet ext      │
   │                            │   │           │ + throwaway key          │
   │ tcpdump on vmnet iface ────┼──▶│──egress──▶│ (system proxy → host)    │
   │   = ground truth, every    │   │  internet │ mitm CA in login keychain│
   │   packet, guest can't hide │   │           └──────────────────────────┘
   │            │               │   │
   │            ▼               ▼   │
   │  session.pcap        flows.jsonl (one line per request, decrypted)
   └───────────────────────────────┘
                    │  out/<run-id>/
                    ▼   enrich → ledger.tsv → ../strawmapuserflow/routes/<run>/ → maps
```

---

## Components

### 1. The VM (reuse cont)
- Base macOS image + Chrome + a chosen wallet extension, pinned by version + checksum.
- Provision once, `cont snapshot` to gold, `cont reset` before each run for a clean identical env.
- The mitm CA is trusted in the guest login keychain during provisioning (guest trusts the host's proxy).

### 2. Capture — host side
- **tcpdump on the vmnet/bridge interface tart uses** = ground truth. Every packet, every host, including WebSocket/QUIC/DNS. Outside the guest, so nothing hides. (First task: confirm the exact interface name for this tart setup — `bridge100` / `vmenetN`.)
- **mitmproxy on the host** decrypts HTTP(S). Guest system proxy → host:8080; guest trusts the mitm CA. This yields the plaintext body = what each request *carries*.
- **DNS log** to map IP→hostname.
- **Kill HTTP/3** in guest Chrome (`--disable-quic`) so nothing skips the TCP proxy; anything still on UDP/443 shows in the pcap and is flagged opaque.

### 3. Decryption trust
- One mitm CA per lab install, gitignored.
- Trusted in the guest **login keychain** (`security add-trusted-cert`) during provisioning — macOS apps and Chrome both honor it. This is the macOS analog of the Linux NSS-db step, and cleaner.
- **Cert pinning** (some native apps): mitm fails, flow shows failed; diff pcap SNI vs mitm hosts → log `opaque: pinned`. We still know *who*, not *what*.

### 4. The driver — one action, reproducibly
- Playwright (or Chrome-DevTools over ssh) drives the guest Chrome: unlock wallet → do the action → approve popup → wait for confirmation.
- One script per action in `actions/` — the same user stories the maps describe (`send-eth`, `ens-send`, `aave-deposit`).
- Pin everything: macOS image, Chrome build, wallet version+checksum, RPC endpoint. A run is `(action, wallet, app, config)` → a deterministic capture; `cont reset` guarantees the clean slate.

### 5–6. Capture format + enrich + emit
Unchanged from transport: `capture/flow_logger.py` writes `flows.jsonl` (who + what-it-carries; secret headers recorded as *present*, never stored). `enrich/` does IP→ASN/org, TLS-cert-SAN → who-terminates-TLS (the Cloudflare finding, mechanically), host→party via a checked-in `parties.yaml`; unknowns flagged for research, never guessed. `enrich/to_ledger.py` reduces to the map's `ledger.tsv` schema. `sees` is proven by capture; `blocks`/`lies` get a human pass.

---

## Hard constraints
- **Never a real seed.** Throwaway key injected at run time, never in an image or snapshot. `cont reset` wipes it between runs. Treat every capture file as sensitive.
- **Decryption is the point.** A host + SNI without the body is nearly worthless; the CA-in-guest-keychain step is load-bearing.
- **The pcap is the auditor.** Any host in the pcap but not in mitm flows = bypass or pinning = itself a finding. Never assume the proxy saw everything.

---

## Build order
1. ~~Interface~~ — `bridge100` (host 192.168.64.1), derived at run time by `lab`, not hardcoded. Done.
2. ~~Provision + gold~~ — `lab bake`. CA is trusted in the **System** keychain (every TLS client, not just login-session apps); proxy via `networksetup` on every service + Chrome policy; QUIC off by policy. Done.
3. ~~Host harness~~ — `lab run <action>`. Done.
4. Decrypt smoke test — `lab run smoke` (example.com + a JSON-RPC POST; `summary.md` must show the RPC body decrypted, and the pcap must show no BYPASS). Implemented; verification result recorded in README "Status".
5. First action `actions/send-eth.js`: MetaMask, mainnet, throwaway key, tiny send. **Next.** Extension launches; key import + approve still to write. Needs a pinned MetaMask build unpacked into `wallet/metamask/`.
6. `enrich/` + `to_ledger.py` → `ledger.tsv`; **diff against the hand-traced `routes/01-eth-send-metamask/ledger.tsv`.** Match = the pipeline is trustworthy and the Cloudflare-shared-cert finding falls out automatically.
7. Then: more wallets (Rainbow, Rabby), more actions (ENS, Aave, swap), native (non-extension) wallets, transparent capture of apps that ignore the system proxy.

## Open questions for Austin
- Wallets for v1 — MetaMask only, or + Rainbow + Rabby?
- Mainnet throwaway key (~$5, real endpoints incl. STX relay) vs testnet? Recommend mainnet throwaway.
- Full request bodies retained (encrypted) or previews only?
