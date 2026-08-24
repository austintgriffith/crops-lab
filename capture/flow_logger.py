"""mitmproxy addon: one JSON line per request into out/<run>/flows.jsonl.

Records who each request goes to and (a preview + hash of) what it carries.
NEVER logs secret header values — presence only. Full bodies are opt-in
(CROPS_FULL_BODY=1) and should be treated as sensitive at rest.

Run (by `lab run`): CROPS_OUT=out/<run> mitmdump -s capture/flow_logger.py
"""
import json
import os
import time
import hashlib

OUT = os.environ.get("CROPS_OUT") or os.path.join(os.getcwd(), "out", "current")
FULL_BODY = os.environ.get("CROPS_FULL_BODY") == "1"
PREVIEW = 2048

# headers we keep verbatim (routing/intent). everything else: presence only.
KEEP = {"origin", "referer", "content-type", "user-agent", "host"}
# headers we record as present-but-redacted (secrets).
SECRET = {"authorization", "cookie", "x-api-key", "x-compliance-secret", "x-metamask-jwt"}

_t0 = time.time()


def _dir():
    os.makedirs(OUT, exist_ok=True)
    return OUT


def _sha(b: bytes) -> str:
    return hashlib.sha256(b or b"").hexdigest()


def response(flow):
    req, resp = flow.request, flow.response
    body = req.raw_content or b""
    hdrs_kept, hdrs_present = {}, []
    for k, v in req.headers.items():
        lk = k.lower()
        if lk in SECRET:
            hdrs_present.append(lk)          # secret is PRESENT; value never stored
        elif lk in KEEP:
            hdrs_kept[lk] = v
    rec = {
        "ts": round(time.time() - _t0, 3),
        "t": round(time.time(), 3),
        "method": req.method,
        "scheme": req.scheme,
        "host": req.pretty_host,             # SNI / Host, the real destination
        "path": req.path.split("?")[0],
        "http_version": resp.http_version,
        "status": resp.status_code,
        "req_headers_kept": hdrs_kept,
        "req_secret_headers_present": hdrs_present,
        "req_body_sha256": _sha(body),
        "req_body_len": len(body),
        "req_body_preview": body[:PREVIEW].decode("utf-8", "replace") if body else "",
        "resp_len": len(resp.raw_content or b""),
    }
    if FULL_BODY and body:
        rec["req_body_full"] = body.decode("utf-8", "replace")
    with open(os.path.join(_dir(), "flows.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


def tls_established_client(data):
    # record the offered SNI even when a flow later fails (pinning etc.)
    try:
        sni = data.client_hello.sni
        if sni:
            with open(os.path.join(_dir(), "sni.log"), "a") as f:
                f.write(f"{round(time.time()-_t0,3)}\t{sni}\n")
    except Exception:
        pass
