# Findings

What ordinary wallet actions actually send, captured decrypted from outside the VM.
Each is a dry run (driven to the wallet's confirm/review screen, not broadcast) except route 01,
which was broadcast once on mainnet to capture the submission leg. Routes 01–03 captured
2026-08-21 (MetaMask 13.45.0); route 04 captured 2026-08-23 (Rainbow 1.6.11). Ethereum mainnet,
default settings. **Next wallet: Ambire.**

## The routes

| | 01 · MM send | 02 · MM ENS | 03 · MM Aave | 04 · Rainbow send |
|---|---:|---:|---:|---:|
| decrypted requests | 266 | 193 | 594 | 90 |
| distinct hosts | 49 | 50 | 66 | 16 |
| ledger rows | 84 | 84 | 303 | — |
| distinct owners | 11 | 12 | 23 | 6 |
| pinned / opaque | 0 | 0 | 0 | 0 |
| QUIC leaks | 0 | 0 | 0 (1 CDN pkt) | 0 |

Every wallet request was decrypted — nothing pinned, nothing bypassed the proxy. The only
non-proxied packets in any run were a handful of Akamai/Fastly CDN and Apple-OS packets
(Chromium background updates, macOS push), never the wallet.

## Route 01 — plain ETH send

A normal user sends ETH with default settings. Broadcast for real:
tx [`0xf6bd6355…92c1`](https://etherscan.io/tx/0xf6bd63559134c01b43e2a84ac9a740e84ceab7009f418500b77c9fa02a4692c1),
0.0002 ETH, ~$0.11 gas.

The wallet's own backbone — the parties **every** route talks to:

- **Consensys** — Infura RPC (nonce, gas estimate, balances, receipts) + the MetaMask backend APIs (feature flags, token list, spot prices, account balances, phishing list, tx simulation via tx-sentinel).
- **Blockaid** — recipient/transaction security screening (security-alerts API).
- **Segment + Sentry** — analytics + crash reporting.
- **Google** — Chrome Web Store update checks.
- background chatter: **Contentful** (CMS content), **Merkl**, **chainid.network**, **MetaMask GitHub Pages**, plus Infura polling across ~10 other chains even for a mainnet-only send.

On broadcast, the signed tx goes to `transaction.api.cx.metamask.io` — the **Smart Transactions
relay**, not the public mempool. This host is absent from the dry runs and appears only here.

Matches the hand-traced map at `strawmapuserflow/routes/01-eth-send-metamask/ledger.tsv`:
15 of 18 hosts. The three gaps are all explained — `etherscan.io` fires only if you click
"View on Etherscan"; `nft.api…` didn't fire this run; the Sentry host is a different ingest
subdomain of the same operator.

## Route 02 — ETH send to an ENS name

Identical to route 01, plus name resolution. The interesting result: **ENS resolves on-chain**.
Typing `ens.eth` produces `eth_call` RPCs to Infura against the ENS registry/resolver — not a
call to any dedicated name-lookup service. The name isn't handed to a new third party; Infura
resolves it (and Infura already sees all your RPC). MetaMask then makes follow-up `eth_call`s to
the *resolved* address (code/balance checks) and screens it exactly like route 01.

Only "new" hosts versus a plain send were Apple OS services (iAd, Stocks) — background noise,
not the wallet.

## Route 03 — supply ETH to Aave V3

A full dapp flow: load app.aave.com, connect MetaMask, supply 0.0005 ETH (→ receive aWETH).
This is where the surface explodes. **~12 parties a plain send never touches:**

| party | why it's there |
|---|---|
| **Aave** (app.aave.com, api.v3.aave.com, Aave Chan) | the dapp frontend + its data APIs |
| **Tenderly** | RPC + transaction simulation |
| **WalletConnect (Reown)** | connector infra + its `verify` API |
| **4byte.directory** | decodes the tx's calldata signature |
| **Datadog** | frontend RUM telemetry |
| **Amplitude** | product analytics |
| **Cloudflare Insights** | web analytics |
| **Sentry** (Aave's own project) | frontend crash reporting |
| **MoonPay**, **Coinbase** | fiat on-ramp widgets — loaded even though unused |
| **fun.xyz** | gas-abstraction SDK |
| **Family** | ConnectKit wallet-connector UI |

Plus a new MetaMask backend the send never hit: `dapp-scanning.api.cx.metamask.io` — MetaMask
scans the site you're connecting to.

The connect step grants app.aave.com your address; from then on every page it loads reports to
that analytics stack. The supply tx itself is simulated by both Tenderly (Aave's side) and
MetaMask's tx-sentinel, and its calldata is decoded via 4byte — three parties see the transaction
before it's ever signed.

## Route 04 — plain ETH send, Rainbow (not MetaMask)

Same action as route 01, same address, different wallet: Rainbow extension 1.6.11, mainnet,
defaults, dry run (driven to the review sheet, not broadcast). Captured Aug 23 2026.
**90 decrypted requests · 16 hosts · 6 companies.**

| host | count | who |
|---|---:|---|
| `rpc.rainbow.me` | 51 | Rainbow RPC proxy — every JSON-RPC read + the broadcast |
| `rainbowjiumask.dataplane.rudderstack.com` | 9 | RudderStack analytics |
| `o331974.ingest.sentry.io` | 6 | Sentry crash reporting |
| `platform.p.rainbow.me` | 6 | Rainbow API — balances, tx history, the "confirmed" |
| `metadata.p.rainbow.me` | 4 | Rainbow — chain list + each chain's RPC URL, pushed at runtime |
| `rainbow.imgix.net` / `rainbowme-res.cloudinary.com` | 3 / 1 | token/image CDNs |
| `firebaseremoteconfig.googleapis.com` | 1 | Google Firebase — feature flags + a persistent install id |
| `addys.p.rainbow.me` | 1 | Rainbow address/balances backend |
| `euc.li` | 1 | ENS avatar/text gateway |
| Google (`clients2/android.clients/www/accounts`) | 5 | Web Store update + sign-in probes |

**The opposite trade-off from MetaMask.** MetaMask's send spreads across ~9 parties (Infura,
Blockaid, tx-sentinel, Segment, Sentry, Google…); Rainbow concentrates into ~6, but **one of
them — Rainbow — is the RPC, the balances you pick from, the fee oracle, the broadcast, and the
word that it landed.** All closed, Cloudflare/AWS-fronted, and the chain list *plus each chain's
RPC URL* are pushed from `metadata.p.rainbow.me`, so Rainbow can re-point every read and the
broadcast with a server change and no update. The wallet-native send is **neither simulated nor
address-screened** — Blockaid-style screening runs only on dApp-originated `eth_sendTransaction`,
not the in-wallet Send — so it is *less* gated than Rabby, which screens the recipient. A custom
RPC escapes the proxy only if it points at a LAN address. A Firebase flag (`BX_send_enabled`) can
remove the Send button entirely. Full code trace with file:line refs:
`../strawmapuserflow/wallets/rainbow-ext-trace.md`.

## Wallet backbone, side by side (plain mainnet ETH send, same address)

| | MetaMask (route 01) | Rainbow (route 04) |
|---|---|---|
| companies on a plain send | ~9 | ~6 |
| who serves the RPC reads | Consensys (Infura) | Rainbow (`rpc.rainbow.me`, closed proxy) |
| pre-sign simulation | yes (tx-sentinel) | **no** (only for dApp tx) |
| recipient screening | yes (Blockaid) | **no** |
| broadcast path | Smart Tx relay (Consensys SERVO) | Rainbow proxy |
| "confirmed" comes from | RPC receipt poll | Rainbow API (`platform.p.rainbow.me`) |
| custom-RPC escape | yes (silently disables STX) | only a LAN address |
| analytics/telemetry | Segment + Sentry (opt-in) | RudderStack + Sentry + Firebase |

## What all three MetaMask routes share

The wallet's own backbone is constant regardless of what you do: **Consensys (Infura + MetaMask
APIs), Blockaid, Segment, Sentry, Google.** The variable part is the dapp — a plain send adds
nothing; a dapp adds its entire vendor stack. The cost of "connect wallet" is measured in
third parties, and most of them are analytics and unused widgets, not the protocol you came for.

## Caveats

- **Dry vs broadcast.** Routes 02–03 stop at the confirm screen, so the on-chain submission +
  relay leg (route 01's `transaction.api…`) is captured only for route 01. Everything up to and
  including the tx *simulation* is captured for all three.
- **Chromium, not Chrome.** Real Chrome 151 blocks loading an unpacked extension, so the wallet
  runs in Playwright's bundled Chromium. Same network stack; the request traffic is identical.
  A Web-Store-signed MetaMask in Google Chrome is the one thing this doesn't reproduce.
- **Owner attribution** is by host pattern (`enrich/to_ledger.py` `PARTIES`), checked-in and
  grown deliberately; unknown owners are flagged `UNKNOWN — research`, never guessed. Only two
  niche testnet RPCs (megaeth, monad) remain unlabeled.
- **`sees` is proven** by the capture; `blocks` / `lies` in the ledger are left blank for a human
  pass.
