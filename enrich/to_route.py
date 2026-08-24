#!/usr/bin/env python3
"""Verify a transit-map route against a capture; upgrade provenance to `observed`.

The route files in ../strawmapuserflow/data/routes/ are hand-curated judgments
(purpose, worst_lie, carries…). A capture cannot author those — it can prove
which requests really happen. This tool does only that:

  verify   python3 enrich/to_route.py out/<run> --route <route.json>
           For every step in the file (steps or prepend_steps), find matching
           requests in flows.jsonl. A step matches when its host was contacted
           AND the evidence is step-specific: either no other step in the file
           shares the host, or a path / JSON-RPC-method token from the step's
           host/purpose text appears in that host's captured traffic.
           Prints per step: OBSERVED / AMBIGUOUS (host seen, evidence shared) /
           NOT SEEN, then every capture host no step claims (candidate steps),
           bucketed by driver.log milestone so a human can place them.

  upgrade  … --route <route.json> --write
           Rewrites the route file: matched steps whose provenance.status is
           code/inferred become {"status": "observed", "ref": "<run-id> · <old ref>"}.
           Nothing else is touched. Never marks AMBIGUOUS or NOT SEEN.

  draft    python3 enrich/to_route.py out/<run> --draft <new-route-id>
           For a flow with no route file yet: writes out/<run>/route-draft.json,
           one step per (host, path-family) with the observed facts filled and
           every judgment field an explicit TODO. build.py rejects TODOs, so the
           draft cannot reach the map without the human pass.

Unknowns stay unknown; nothing is guessed (same no-fake-data rule as the maps).
"""
import argparse
import json
import pathlib
import re
import sys
from collections import OrderedDict

OS_NOISE = re.compile(r"(\.apple\.com|\.mzstatic\.com|\.icloud\.com|\.aaplimg\.com)$|^example\.com$")
HOST_RX = re.compile(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", re.I)
PATH_TOKEN_RX = re.compile(r"/[A-Za-z0-9_][A-Za-z0-9_/.-]{3,}")
RPC_TOKEN_RX = re.compile(r"\b(?:eth|net|web3|wallet|personal|debug)_[A-Za-z0-9]+")
BODY_METHOD_RX = re.compile(r'"method"\s*:\s*"([A-Za-z0-9_]+)"')
BODY_OP_RX = re.compile(r'"operationName"\s*:\s*"([A-Za-z0-9_]+)"')
CAMEL_RX = re.compile(r"\b[A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b")
NON_HTTP_HOST_RX = re.compile(r"^\(|^no network|devp2p|localhost", re.I)


def path_family(path):
    # collapse ids/hashes so /v2/accounts/0xabc… groups with /v2/accounts/0xdef…
    return re.sub(r"/(0x[0-9a-fA-F]+|[0-9a-fA-F]{16,}|\d+)", "/{id}", path)


def load_capture(run_dir):
    """flows.jsonl → per-host evidence: paths, rpc methods, counts, times."""
    hosts = {}
    with open(run_dir / "flows.jsonl") as f:
        for line in f:
            r = json.loads(line)
            h = hosts.setdefault(r["host"], {
                "count": 0, "paths": OrderedDict(), "rpc": set(), "ops": set(),
                "methods": set(), "secret": set(), "first_t": None, "last_t": None,
            })
            h["count"] += 1
            fam = path_family(r["path"])
            h["paths"][fam] = h["paths"].get(fam, 0) + 1
            h["methods"].add(r["method"])
            h["secret"] |= set(r.get("req_secret_headers_present", []))
            for m in BODY_METHOD_RX.findall(r.get("req_body_preview", "")):
                h["rpc"].add(m)
            for m in BODY_OP_RX.findall(r.get("req_body_preview", "")):
                h["ops"].add(m.lower())
            t = r.get("t")
            if t is not None:
                h["first_t"] = t if h["first_t"] is None else min(h["first_t"], t)
                h["last_t"] = t if h["last_t"] is None else max(h["last_t"], t)
    return hosts


def load_milestones(run_dir):
    """driver.log '[t=<epoch>] text' lines, in order."""
    out = []
    log = run_dir / "driver.log"
    if not log.exists():
        return out
    for line in log.read_text().splitlines():
        m = re.match(r"\[t=([0-9.]+)\]\s+(.*)", line.strip())
        if m:
            out.append((float(m.group(1)), m.group(2)))
    return out


def milestone_bucket(milestones, t):
    if t is None or not milestones:
        return "?"
    label = "before driver start"
    for mt, text in milestones:
        if t >= mt:
            label = text
        else:
            break
    return label


def step_hosts(step):
    return [h.lower() for h in HOST_RX.findall(step["host"])]


def step_tokens(step):
    """Path fragments + JSON-RPC method names named in the step's own text."""
    text = " ".join([step.get("host", ""), step.get("name", ""), step.get("purpose", "")])
    toks = set(RPC_TOKEN_RX.findall(text))
    for p in PATH_TOKEN_RX.findall(text):
        toks.add(p.rstrip("/.").lower())
    # host strings like 'gateway.uniswap.org/v1/quote' put the path in `host`;
    # bare-word labels like '(SessionService)' become word tokens — but only
    # from what remains after the hostnames themselves are stripped out
    rest = HOST_RX.sub(" ", step.get("host", ""))
    rest = PATH_TOKEN_RX.sub(" ", rest)
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_-]{4,}", rest):
        toks.add(w.lower())
    # camelCase identifiers in name/purpose (GraphQL ops, API method names) —
    # prose is never camelCase, so these are specific
    for w in CAMEL_RX.findall(step.get("name", "") + " " + step.get("purpose", "")):
        toks.add(w.lower())
    return toks


def token_hits(tokens, ev):
    hits = []
    cap_paths = " ".join(ev["paths"]).lower()
    # word tokens must match a whole path segment, not a substring — else a
    # brand name like MetaMask matches half the traffic
    segs = set(re.split(r"[/?&=.,;+\s]+", cap_paths))
    for t in tokens:
        if t in ev["rpc"] or t in ev["ops"]:
            hits.append(t)
        elif t.startswith("/") and t in cap_paths:
            hits.append(t)
        elif not t.startswith("/") and t in segs:
            hits.append(t)
    return hits


def verify(route, hosts, milestones):
    steps = route.get("steps") or route.get("prepend_steps") or []
    by_host, tokens_of = {}, {}
    for s in steps:
        tokens_of[s["id"]] = step_tokens(s)
        for h in step_hosts(s):
            by_host.setdefault(h, []).append(s["id"])
    results, claimed = [], set()
    for s in steps:
        shs = step_hosts(s)
        if NON_HTTP_HOST_RX.search(s["host"]) or not shs:
            results.append((s, "SKIP", "not an HTTP host — capture can't see it"))
            continue
        seen = [h for h in shs if h in hosts]
        if not seen:
            results.append((s, "NOT SEEN", "host absent from capture"))
            continue
        h = seen[0]
        ev = hosts[h]
        shared = [sid for sid in by_host[h] if sid != s["id"]]
        # a token is step-specific evidence only if no other step on this host
        # also names it — a hit both steps share proves neither
        others = set().union(*[tokens_of[sid] for sid in shared]) if shared else set()
        hits = [t for t in token_hits(tokens_of[s["id"]], ev) if t not in others]
        if not shared:
            claimed.add(h)
            why = f"{ev['count']} req"
            if hits:
                why += " · " + "/".join(sorted(hits)[:3])
            results.append((s, "OBSERVED", why))
        elif hits:
            claimed.add(h)
            results.append((s, "OBSERVED", f"{ev['count']} req on host · matched {'/'.join(sorted(hits)[:3])}"))
        else:
            claimed.add(h)
            results.append((s, "AMBIGUOUS", f"host seen ({ev['count']} req) but {len(shared) + 1} steps share it and no step-specific path/rpc token matched"))
    unclaimed = []
    for h, ev in sorted(hosts.items(), key=lambda kv: -kv[1]["count"]):
        if h in claimed or OS_NOISE.search(h):
            continue
        unclaimed.append((h, ev))
    return results, unclaimed


TODO = "TODO(human)"


def draft(route_id, hosts, milestones, run_id):
    steps = []
    for h, ev in sorted(hosts.items(), key=lambda kv: (kv[1]["first_t"] or 0)):
        if OS_NOISE.search(h):
            continue
        for fam, n in ev["paths"].items():
            note = f"{n} req · methods {'/'.join(sorted(ev['methods']))}"
            if ev["rpc"]:
                note += " · rpc " + ",".join(sorted(ev["rpc"])[:6])
            if ev["secret"]:
                note += " · secret hdr " + ",".join(sorted(ev["secret"]))
            steps.append({
                "id": re.sub(r"[^a-z0-9]+", "-", (h.split(".")[0] + fam).lower()).strip("-")[:48],
                "phase": TODO, "name": f"{h} · {fam}", "host": h,
                "actor": TODO, "purpose": TODO, "need": TODO,
                "carries": [], "returns": TODO, "can_block": False,
                "on_failure": TODO,
                "worst_lie": {"outcome": TODO},
                "removable_by": TODO,
                "provenance": {"status": "observed", "ref": run_id},
                "notes": note + f" · first seen during: {milestone_bucket(milestones, ev['first_t'])}",
            })
    return {"id": route_id, "title": TODO,
            "context": {"wallet": TODO, "platform": TODO, "network": TODO,
                        "settings": TODO, "observed": run_id.split("-")[0]},
            "_comment": f"DRAFT emitted by to_route.py from capture {run_id}. Every {TODO} needs the human pass; ids will collide with duplicates — dedupe. build.py must fail on this file until finished.",
            "steps": steps}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", help="out/<run> directory containing flows.jsonl")
    ap.add_argument("--route", help="existing route JSON to verify against")
    ap.add_argument("--write", action="store_true", help="upgrade matched steps' provenance in place")
    ap.add_argument("--draft", metavar="ROUTE_ID", help="emit out/<run>/route-draft.json instead")
    args = ap.parse_args()

    run_dir = pathlib.Path(args.run)
    if not (run_dir / "flows.jsonl").exists():
        sys.exit(f"no flows.jsonl in {run_dir}")
    run_id = run_dir.name
    hosts = load_capture(run_dir)
    milestones = load_milestones(run_dir)

    if args.draft:
        blob = draft(args.draft, hosts, milestones, run_id)
        out = run_dir / "route-draft.json"
        out.write_text(json.dumps(blob, indent=2, ensure_ascii=False) + "\n")
        print(f"{out}: {len(blob['steps'])} draft steps — every judgment field is {TODO}")
        return

    if not args.route:
        sys.exit("pass --route <route.json> or --draft <id>")
    route_path = pathlib.Path(args.route)
    route = json.loads(route_path.read_text())
    results, unclaimed = verify(route, hosts, milestones)

    print(f"# {route['id']} vs capture {run_id}\n")
    width = max((len(s['id']) for s, _, _ in results), default=10)
    upgraded = 0
    for s, verdict, why in results:
        mark = {"OBSERVED": "✓", "AMBIGUOUS": "~", "NOT SEEN": "✗", "SKIP": "·"}[verdict]
        prov = s["provenance"]["status"]
        print(f"{mark} {s['id']:<{width}}  {verdict:<9} [{prov}] {why}")
        if verdict == "OBSERVED" and args.write and prov in ("code", "inferred"):
            s["provenance"] = {"status": "observed", "ref": f"{run_id} · {s['provenance']['ref']}"}
            upgraded += 1
    if unclaimed:
        print(f"\n## capture hosts no step claims ({len(unclaimed)}) — candidate steps, or noise to rule out")
        for h, ev in unclaimed:
            tops = " ".join(list(ev["paths"])[:3])
            rpc = (" rpc " + ",".join(sorted(ev["rpc"])[:4])) if ev["rpc"] else ""
            print(f"  {h} · {ev['count']} req · {tops}{rpc} · first seen during: {milestone_bucket(milestones, ev['first_t'])}")
    if args.write:
        if upgraded:
            route_path.write_text(json.dumps(route, indent=2, ensure_ascii=False) + "\n")
            print(f"\nwrote {route_path}: {upgraded} steps upgraded to observed (ref prefixed with {run_id})")
        else:
            print("\nnothing to upgrade — no OBSERVED step still marked code/inferred")


if __name__ == "__main__":
    main()
