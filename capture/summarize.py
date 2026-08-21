#!/usr/bin/env python3
"""Audit one capture: what the proxy decrypted vs what actually left the VM.

    python3 capture/summarize.py out/<run-id>

The pcap is the auditor. Rules (each line of the summary is one of these):
  - a TLS SNI offered to the proxy with no decrypted flow  -> OPAQUE (pinned / failed)
  - a guest->public TCP:443 packet not addressed to the proxy -> BYPASS (ignored the proxy)
  - any guest UDP:443                                        -> QUIC LEAK (HTTP/3 got past the kill)
  - no pcap at all                                           -> NO GROUND TRUTH, say so loudly
Prints markdown; `lab run` tees it to summary.md. Never guesses a party.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

out = sys.argv[1].rstrip("/")
meta = {}
if os.path.exists(f"{out}/meta.txt"):
    for line in open(f"{out}/meta.txt"):
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
guest_ip = meta.get("guest_ip") or (open(f"{out}/guest_ip").read().strip() if os.path.exists(f"{out}/guest_ip") else "")
proxy = meta.get("host_proxy", "")
proxy_ip, _, proxy_port = proxy.partition(":")

# ── decrypted flows ────────────────────────────────────────────────────
flows = []
if os.path.exists(f"{out}/flows.jsonl"):
    for line in open(f"{out}/flows.jsonl"):
        try:
            flows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
by_host = defaultdict(list)
for f in flows:
    by_host[f["host"]].append(f)

snis = Counter()
if os.path.exists(f"{out}/sni.log"):
    for line in open(f"{out}/sni.log"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 2 and parts[1]:
            snis[parts[1]] += 1
opaque = sorted(h for h in snis if h not in by_host)

# ── wire truth ─────────────────────────────────────────────────────────
pcap = f"{out}/session.pcap"
wire = None
if os.path.exists(pcap) and os.path.getsize(pcap) > 24:
    wire = {"tcp": Counter(), "udp": Counter(), "dns": {}, "bypass": Counter(), "quic": Counter(), "os": Counter(), "proxied": 0}
    try:
        txt = subprocess.run(["/usr/sbin/tcpdump", "-nn", "-q", "-r", pcap], capture_output=True, text=True, timeout=120).stdout
    except Exception as e:  # unreadable pcap is itself worth reporting
        txt = ""
        wire["error"] = str(e)
    pkt = re.compile(r"^\S+ IP6? (\S+?)\.(\d+) > (\S+?)\.(\d+): (tcp|UDP|udp)", re.M)
    for src, sport, dst, dport, proto in pkt.findall(txt):
        if src != guest_ip:
            continue
        proto = proto.lower()
        if proto == "tcp":
            if dst == proxy_ip and dport == proxy_port:
                wire["proxied"] += 1
            elif dst.startswith("17."):          # Apple 17.0.0.0/8 = macOS itself
                wire["os"][dst] += 1
            else:
                wire["tcp"][(dst, dport)] += 1
                if dport == "443":
                    wire["bypass"][dst] += 1
        elif dst.startswith("17."):
            wire["os"][dst] += 1
        else:
            wire["udp"][(dst, dport)] += 1
            if dport == "443":
                wire["quic"][dst] += 1
    # DNS answers map IP -> name for the bypass list. (A records only.)
    try:
        dns = subprocess.run(["/usr/sbin/tcpdump", "-nn", "-r", pcap, "udp port 53"], capture_output=True, text=True, timeout=120).stdout
        for line in dns.splitlines():
            m = re.search(r"\d+/\d+/\d+ (.*)", line)
            if not m:
                continue
            names = re.findall(r"([A-Za-z0-9.-]+\.)\s+A\s+(\d+\.\d+\.\d+\.\d+)", m.group(1))
            # tcpdump prints "A 1.2.3.4" pairs after the query name; keep best-effort
            q = re.search(r"A\? ([A-Za-z0-9.-]+)\.", line)
            for ip in re.findall(r"A (\d+\.\d+\.\d+\.\d+)", m.group(1)):
                wire["dns"].setdefault(ip, q.group(1) if q else "?")
    except Exception:
        pass

# ── print ──────────────────────────────────────────────────────────────
print(f"# capture {os.path.basename(out)}")
print()
print(f"action: {meta.get('action','?')} · guest {guest_ip} · proxy {proxy} · action_rc {meta.get('action_rc','?')}")
print()
print(f"## decrypted: {len(flows)} requests · {len(by_host)} hosts")
print()
print("| host | req | methods | secret headers present |")
print("|---|---:|---|---|")
for h, fs in sorted(by_host.items(), key=lambda kv: -len(kv[1])):
    methods = "/".join(sorted({f["method"] for f in fs}))
    secrets = ",".join(sorted({s for f in fs for s in f.get("req_secret_headers_present", [])})) or "—"
    print(f"| {h} | {len(fs)} | {methods} | {secrets} |")
print()
print(f"## opaque: {len(opaque)} SNIs offered, never decrypted (pinned or handshake failed)")
print()
for h in opaque:
    print(f"- {h} ({snis[h]} handshakes)")
if not opaque:
    print("- none")
print()
if wire is None:
    print("## wire: NO PCAP — no ground truth for this run")
    print()
    print("Everything above is what the proxy *says* it saw. Nothing here can prove the guest sent nothing else.")
    if os.path.exists(f"{out}/PCAP_SKIPPED"):
        print(f"Reason: {open(f'{out}/PCAP_SKIPPED').read().strip()}")
else:
    bypass = wire["bypass"]; quic = wire["quic"]
    print(f"## wire: {wire['proxied']} proxied pkts · {len(bypass)} BYPASS dst · {len(quic)} QUIC dst · "
          f"{sum(wire['os'].values())} Apple-OS pkts")
    print()
    print("BYPASS/QUIC below exclude Apple 17.0.0.0/8 (macOS push/OCSP/update — not the browser under test).")
    print()
    if "error" in wire:
        print(f"pcap read error: {wire['error']}")
    if bypass:
        print("### BYPASS — guest spoke TLS to these directly, not through the proxy")
        for ip, n in bypass.most_common():
            print(f"- {ip} ({wire['dns'].get(ip,'no DNS seen')}) · {n} pkts")
        print()
    if quic:
        print("### QUIC LEAK — udp/443 left the guest")
        for ip, n in quic.most_common():
            print(f"- {ip} ({wire['dns'].get(ip,'no DNS seen')}) · {n} pkts")
        print()
    other = [(k, n) for k, n in wire["tcp"].items() if k[1] != "443"] + \
            [(k, n) for k, n in wire["udp"].items() if k[1] not in ("443", "53")]
    if other:
        print("### other egress (non-443, non-DNS)")
        for (ip, port), n in sorted(other, key=lambda x: -x[1])[:40]:
            print(f"- {ip}:{port} ({wire['dns'].get(ip,'no DNS seen')}) · {n} pkts")
        print()
    if not bypass and not quic and not other:
        print("clean: every guest egress was DNS, or TCP to the proxy.")
