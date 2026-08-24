#!/usr/bin/env python3
"""Reduce a capture (out/<run>/flows.jsonl) to the transit-map ledger schema.

Collapses retries/polling to one row per (host, path-family), classifies the
owner via parties.yaml, and emits ledger.tsv — the same columns the maps read
from ../strawmapuserflow/routes/*/ledger.tsv.

  python3 enrich/to_ledger.py out/<run-id>/flows.jsonl > ledger.tsv

'sees' is proven by the capture. 'blocks'/'lies' need a human pass — emitted
blank for a reviewer. Unknown owners are flagged 'UNKNOWN — research', never
guessed (same no-fake-data rule as the maps).
"""
import json
import sys
import re
from collections import OrderedDict

# host regex -> (owner, kind). Checked-in ground truth; grow it, never guess inline.
PARTIES = [
    # order matters: more specific patterns first.
    (r"security-alerts\.api\.cx", "Blockaid", "op"),
    (r"\.cx\.metamask\.io$", "Consensys (MetaMask backends)", "op"),   # api.cx + static.cx
    (r"\.execution\.metamask\.io$", "Consensys (MetaMask backends)", "op"),
    (r"^metamask\.github\.io$", "MetaMask (GitHub Pages)", "edge"),
    (r"\.infura\.io$", "Consensys (Infura RPC)", "op"),                # all chains, mainnet + L2s + testnets
    (r"^etherscan\.io$", "Etherscan", "op"),
    (r"\.g\.alchemy\.com$", "Alchemy", "op"),
    (r"amplitude\.com$", "Amplitude", "op"),
    (r"segment\.io$", "Segment", "op"),
    (r"sentry\.io$", "Sentry", "op"),
    (r"metadata\.ens\.domains$", "ENS metadata service", "op"),
    # --- dapp surface (route 03, Aave supply) ---
    (r"aave\.com$", "Aave (Avara) frontend/API", "op"),
    (r"aavechan\.com$", "Aave Chan Initiative", "op"),
    (r"tenderly\.co$", "Tenderly (RPC + simulation)", "op"),
    (r"walletconnect\.(org|com)$", "WalletConnect (Reown)", "op"),
    (r"moonpay\.com$", "MoonPay (fiat on-ramp)", "op"),
    (r"coinbase\.com$", "Coinbase (on-ramp)", "op"),
    (r"datadoghq\.com$", "Datadog (RUM telemetry)", "op"),
    (r"cloudflareinsights\.com$", "Cloudflare (web analytics)", "edge"),
    (r"4byte\.directory$", "4byte.directory (calldata sig registry)", "op"),
    (r"fun\.xyz$", "fun.xyz (gas abstraction SDK)", "op"),
    (r"family\.co$", "Family (ConnectKit UI)", "op"),
    (r"googleapis\.com$", "Google", "op"),
    (r"\.google\.com$", "Google", "op"),                              # clients2/accounts/www/android.clients
    (r"contentful\.com$", "Contentful (CMS)", "op"),
    (r"^chainid\.network$", "ethereum-lists (chainid.network)", "op"),
    (r"^api\.merkl\.xyz$", "Merkl (Angle Labs)", "op"),
    (r"^example\.com$", "lab proxy-connectivity probe (not wallet)", "op"),
    (r"\.apple\.com$", "Apple (macOS background — not wallet)", "os"),
    (r"apps\.aavechan\.com$", "Aave Chan Initiative", "op"),
    (r"^app\.aave\.com$", "Aave frontend (Cloudflare)", "edge"),
]

# Must match ../strawmapuserflow/routes/*/ledger.tsv exactly (16 columns).
COLS = ["phase", "step", "host", "owner", "purpose", "need", "carries",
        "response_trusted_for", "on_failure", "sees", "blocks", "lies",
        "self_hostable", "removable_by", "code_ref", "notes"]


def owner(host):
    for rx, name, _ in PARTIES:
        if re.search(rx, host):
            return name
    return "UNKNOWN — research"


def path_family(path):
    # collapse ids/hashes so /v2/accounts/0xabc… groups with /v2/accounts/0xdef…
    return re.sub(r"/(0x[0-9a-fA-F]+|[0-9a-fA-F]{16,}|\d+)", "/{id}", path)


def main(path):
    seen = OrderedDict()
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            key = (r["host"], path_family(r["path"]))
            if key not in seen:
                seen[key] = {"host": r["host"], "count": 0,
                             "secret": set(), "methods": set()}
            e = seen[key]
            e["count"] += 1
            e["methods"].add(r["method"])
            e["secret"] |= set(r.get("req_secret_headers_present", []))

    print("\t".join(COLS))
    for (host, fam), e in seen.items():
        notes = f"{e['count']} req; methods {'/'.join(sorted(e['methods']))}"
        if e["secret"]:
            notes += f"; carries secret hdr: {','.join(sorted(e['secret']))}"
        row = {
            "phase": "", "step": fam, "host": host, "owner": owner(host),
            "purpose": "", "need": "", "carries": "",  # human/enrich pass fills these
            "response_trusted_for": "", "on_failure": "",
            "sees": "yes", "blocks": "", "lies": "",
            "self_hostable": "", "removable_by": "", "code_ref": "capture", "notes": notes,
        }
        print("\t".join(row[c] for c in COLS))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: to_ledger.py out/<run>/flows.jsonl")
    main(sys.argv[1])
