"""mitmproxy addon: reach a LAN host through a local relay (LAN_RELAY=host:port).

macOS Local Network privacy can deny the mitmdump binary LAN access while the
system python keeps it. `lab` then starts relay.py (system python) on
127.0.0.1:18545 → LAN_RELAY, and this addon points matching requests at it.
The original host/port are put back before flow_logger logs the response, so
the capture still shows the real destination.
"""
import os

TARGET = os.environ.get("LAN_RELAY", "")
HOST, _, PORT = TARGET.partition(":")


def request(flow):
    if HOST and flow.request.host == HOST and flow.request.port == int(PORT or 80):
        flow.metadata["lan_relay"] = (flow.request.host, flow.request.port)
        flow.request.host, flow.request.port = "127.0.0.1", 18545
        flow.request.headers["host"] = TARGET


def response(flow):
    orig = flow.metadata.get("lan_relay")
    if orig:
        flow.request.host, flow.request.port = orig
