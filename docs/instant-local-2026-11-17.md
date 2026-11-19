# Instant Wallet, local copy: what still leaks (lab, 2026-11-17)

Image `crops-warm-instant-local` (instant-wallet c26b39d + iw-indexer, built in the VM). The local server's
outbound calls go through the lab proxy (NODE_USE_ENV_PROXY), so they are decrypted too. Tor and the LAN node: pcap.
Wallet 0x34F9…C587. No broadcasts. Code trace of every host: see the session notes (agent report, c26b39d).

## Runs (60 s on Home unless noted)

| Setup | Run | Out to third parties |
|---|---|---|
| Online, default | 20261117-094732-home-instant | instantwallet.io (all reads, address), Plausible |
| Online + .onion node | 20261117-094936-home-instant-onion | Ethereum reads over Tor (EF gateway 152.236.3.22 UDP). Portfolio, NFTs, 13 other chains: instantwallet.io with address |
| Local, own Alchemy key | 20261117-093746-home-instant-local | ~720 Alchemy calls/min, 14 chains, address in nearly all, your key. Plausible, GitHub, npm |
| Local + LAN node + indexer | 20261117-094246-home-instant-local-node | Ethereum off Alchemy (except NFTs). ~650/min to Alchemy for the 13 other chains. Plausible, GitHub, npm |
| Local + .onion node | 20261117-094443-home-instant-local-onion | Chain reads over Tor (relays only, opaque). Ethereum balances + tokens STILL to Alchemy (portfolio route ignores Settings → Your node). 13 chains to Alchemy |
| Send to review, local + node | 20261117-095203-send-eth-instant-local-node | + euc.li (server, recipient's ENS name, your IP) |
| Send to review, local + .onion | 20261117-095519-send-eth-instant-local-onion | + Alchemy eth_getBalance/getTokenBalances on Ethereum |
| Swap, local + node / .onion | 20261117-095324-…, 20261117-095651-… | LI.FI quote ×6 (address). Stops: no relay on a local copy → no fee → can't sign |

## Biggest leaks, in order

1. Other networks: 13 chains you have no node for keep polling Alchemy with your address (~650/min).
2. Tor setting doesn't reach the server: Ethereum balances and tokens still go to Alchemy with your address.
3. Local copy uses YOUR Alchemy key from YOUR IP: Alchemy can tie the queries to your account. Worse than the hosted site.
4. Plausible loads on the local copy.
5. NFTs always via Alchemy NFT API; prices via Alchemy by-symbol.
6. Startup: GitHub (4 repos) and npm on every start.
7. ENS avatars via euc.li; LI.FI on every swap quote.

## Fixes (Instant Wallet)

1. Local copy: only the networks you have a node for (others off, not Alchemy).
2. Settings → Your node goes to every server route (portfolio, ens, avatar, explain, nfts), not only the relay.
3. Node over Tor, no indexer: balances from the node (known token list + balanceOf) over Tor.
4. No Plausible on a local copy.
5. NFTs and avatars off on a local copy unless turned on; images through the local server.
6. Prices from the indexer only.
7. `run-local.sh --offline`: no git/npm unless asked; bundle local-ssl-proxy.
8. Swap: Uniswap-only option, no LI.FI.
9. `LOGS_URL` to Alchemy only if the user says yes.
10. clear-signing-safe-kit installs from git with no integrity check: pin a hash or publish it.

## Settings for zero leak today

Not possible today. Closest: local copy + a node for every network in .env.local (`RPC_URL_<id>`) + indexer + your relay
pointed at your node. Still out: Plausible, NFTs, Alchemy prices, euc.li, GitHub/npm at start, LI.FI on swaps.

## Evening runs (all dry)

Own node on the hosted site (Settings → Your node = http://192.168.68.54:8545):
- Ethereum reads go straight from the browser to the node (14 calls on Home, all 200). No /api/rpc/1 to instantwallet.io after the switch.
- Balances, NFTs, names, relay fee, explain and the other 13 networks still go to instantwallet.io with your address.
- New: the browser POSTs the full unsigned Safe tx (from, to, data) to sim.wedgie.dev from your IP. Seen on default hosted sends too, not only with own node or Tor.

Runs: 20261117-180121-home-instant-node, 180427-send-eth-instant-node, 182453-swap-instant-node, 183858-send-token-instant-node, 182800-swap-instant-onion, 184027-send-token-instant-onion, 184617-send-eth-instant-onion, 182129-send-eth-instant-local, 183111-swap-instant-local, 184150-send-token-instant-local, 184305-send-token-instant-local-node, 184423-send-token-instant-local-onion.

Driver notes: this wallet holds ~$0.83 ETH + 0.12 USDC, so use TOKEN=USDC SEND_USD=0.05 and SWAP_USD=0.30. Over Tor the review card can still be loading when the dry run stops (fee not fetched).

## Simulator (Nov 18)

- The simulator is now Instant Wallet's: repo clawdbotatg/iw-sim (was clear-sim). Hosted at sim.wedgie.dev, and sim.instantwallet.io once its DNS record is added.
- The local copy (run-local.sh) starts its own iw-sim. The wallet asks it first and sim.wedgie.dev only if it gets no answer.
- iw-sim needs a node with `debug_traceCall`. On our LAN that's http://192.168.68.74:8545 or http://192.168.68.79:8545 (reth, mainnet). 192.168.68.54:8545 has no debug API, so with it the sim falls back to Alchemy.
