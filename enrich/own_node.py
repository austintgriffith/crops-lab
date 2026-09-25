#!/usr/bin/env python3
"""Prove what a wallet does once YOU point it at your own node.

  python3 enrich/own_node.py --route <route.json> --node 192.168.68.54 \
      --marker 'rpc-edit: done' out/<run> [out/<run2> …] [--tx 0x…] [--write]

Each run must have switched the wallet's RPC to the node through the wallet's
own UI and logged a driver.log milestone matching --marker right after. Only
traffic AFTER that milestone counts. Every step of the route gets one state:

  local     the node received this step's JSON-RPC method, and the step's
            original host got nothing after the switch
  out       the step's original host was still contacted after the switch
  gone      a step the setting is known to switch off (--toggle's `implies`,
            e.g. MetaMask's Smart Transactions relay) whose host got nothing
            in a run that really sent (--tx)
  unseen    nothing either way in these runs (click-gated, code-traced, not
            reached). Not a claim — the map shows it unchanged, marked untested.

Node calls whose method no route step names are listed as ADD candidates
(e.g. eth_sendRawTransaction when the route's broadcast went to a relay).
--write stores the result as the route's `own_node` block; nothing else in the
route file is touched. Same rule as to_route.py: nothing is guessed.
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from to_route import OS_NOISE, BODY_METHOD_RX, RPC_TOKEN_RX, step_hosts, step_tokens, token_hits, path_family  # noqa: E402


def split_capture(run_dir, marker):
    """(before, after, t_switch): per-host evidence split at the marker milestone."""
    t_switch = None
    for line in (run_dir / "driver.log").read_text().splitlines():
        m = re.match(r"\[t=([0-9.]+)\]\s+(.*)", line.strip())
        if m and re.search(marker, m.group(2)):
            t_switch = float(m.group(1)); break
    if t_switch is None:
        sys.exit(f"{run_dir.name}: no driver.log milestone matching {marker!r}")
    before, after = {}, {}
    for line in open(run_dir / "flows.jsonl"):
        r = json.loads(line)
        side = after if r.get("t", 0) >= t_switch else before
        h = side.setdefault(r["host"], {"count": 0, "paths": {}, "rpc": set(), "ops": set()})
        h["count"] += 1
        fam = path_family(r["path"]); h["paths"][fam] = h["paths"].get(fam, 0) + 1
        h["rpc"] |= set(BODY_METHOD_RX.findall(r.get("req_body_preview", "")))
    return before, after, t_switch


def merge(dst, src):
    for h, ev in src.items():
        d = dst.setdefault(h, {"count": 0, "paths": {}, "rpc": set(), "ops": set()})
        d["count"] += ev["count"]; d["rpc"] |= ev["rpc"]
        for p, n in ev["paths"].items(): d["paths"][p] = d["paths"].get(p, 0) + n


def resolve_steps(route_path):
    r = json.loads(route_path.read_text())
    steps = list(r.get("prepend_steps", []))
    if r.get("extends"):
        steps += resolve_steps(route_path.parent / f"{r['extends']}.json")
    else:
        steps += r.get("steps", [])
    return steps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--route", required=True)
    ap.add_argument("--node", required=True, help="host the node traffic reached in the capture")
    ap.add_argument("--label", help="what the wallet was set to, if not --node (e.g. a 127.0.0.1 forwarder)")
    ap.add_argument("--marker", required=True, help="driver.log milestone logged right after the switch")
    ap.add_argument("--tx", help="mainnet tx hash if a run broadcast")
    ap.add_argument("--toggle", required=True, help="toggles.json key for this wallet's custom-RPC setting")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    before, after, runs = {}, {}, []
    for rd in map(pathlib.Path, a.runs):
        b, af, _ = split_capture(rd, a.marker)
        merge(before, b); merge(after, af); runs.append(rd.name)
    node = after.get(a.node, {"count": 0, "rpc": set(), "paths": {}})
    route_path = pathlib.Path(a.route)
    toggles = {t["key"]: t for t in json.loads((route_path.parent.parent / "toggles.json").read_text())["toggles"]}
    implied = set(toggles[a.toggle].get("implies", []))   # what the code says this setting switches off
    steps = resolve_steps(route_path)

    by_host = {}
    for s in steps:
        for h in step_hosts(s): by_host.setdefault(h, []).append(s["id"])
    toks = {s["id"]: step_tokens(s) for s in steps}

    def find(h, side):
        # exact host, else a parent/child host (step says o123.ingest.sentry.io, capture saw sentry.io)
        if h in side: return h
        return next((c for c in side if h.endswith("." + c) or c.endswith("." + h)), None)

    result, named = {}, set()
    for s in steps:
        hosts = step_hosts(s)
        rpc = set(RPC_TOKEN_RX.findall(" ".join([s.get("host", ""), s.get("name", ""), s.get("purpose", "")])))
        named |= rpc
        seen = next((c for c in (find(h, after) for h in hosts) if c), None)
        local_hits = sorted(rpc & node["rpc"])
        if seen:
            ev = after[seen]
            shared = [x for h in hosts for x in by_host.get(h, []) if x != s["id"]]
            others = set().union(*[toks[x] for x in shared]) if shared else set()
            hits = [t for t in token_hits(toks[s["id"]], ev) if t not in others]
            if not hits and local_hits and not (rpc & ev["rpc"]):
                # shared host (e.g. api.rabby.io = RPC proxy + REST API): the node got this
                # step's methods; the old host got none of them and none of its paths after the switch
                state, why = "local", f"{a.node} · {'/'.join(local_hits)}; {seen} got none of these methods after switch"
            elif shared and not hits:
                state, why = "unseen", f"{seen} still contacted ({ev['count']} req) but this exact call wasn't singled out"
            else:
                state, why = "out", f"{seen} · {ev['count']} req after switch" + (f" · {'/'.join(sorted(hits)[:3])}" if hits else "")
        elif local_hits:
            state, why = "local", f"{a.node} · {'/'.join(local_hits)}; {', '.join(hosts) or s['host']} got 0 after switch"
        elif hosts and a.tx and s.get("removable_by") in implied:
            # the run really sent: a broadcast/confirm host that got nothing was skipped
            state, why = "gone", f"real send {a.tx[:10]}… went out via {a.node}; {hosts[0]} got 0 req"
        else:
            b = next((c for c in (find(h, before) for h in hosts) if c), None)
            state, why = "unseen", (f"{b} seen before the switch only, not after" if b else "not in these runs")
        result[s["id"]] = {"state": state, "ref": why}

    width = max(len(s["id"]) for s in steps)
    for s in steps:
        r = result[s["id"]]
        print(f"  {r['state']:6}  {s['id']:{width}}  {r['ref']}")
    extra = sorted(node["rpc"] - named)
    print(f"\nnode {a.node}: {node['count']} req after switch · methods {sorted(node['rpc'])}")
    if extra: print(f"ADD candidates (node methods no step names): {extra}")
    claimed = {c for s in steps for h in step_hosts(s) for c in [find(h, after)] if c} | {a.node}
    un = [(h, ev["count"]) for h, ev in sorted(after.items(), key=lambda kv: -kv[1]["count"])
          if h not in claimed and not OS_NOISE.search(h) and not re.search(r"(^|\.)google\.com$|^chromewebstore\.googleapis\.com$", h)]   # browser, not wallet
    if un: print("still out, no step on the map: " + ", ".join(f"{h} ({n})" for h, n in un))

    if a.write:
        r = json.loads(route_path.read_text())
        block = {"node": a.label or a.node, "runs": runs, "steps": result}
        if a.tx: block["tx"] = a.tx
        if un: block["unmapped"] = [h for h, _ in un]
        keep = r.get("own_node", {})
        for k in ("add", "note"):   # hand-authored parts survive a rerun
            if keep.get(k): block[k] = keep[k]
        r["own_node"] = block
        route_path.write_text(json.dumps(r, indent=2, ensure_ascii=False) + "\n")
        print(f"\nwrote own_node → {route_path}")


if __name__ == "__main__":
    main()
