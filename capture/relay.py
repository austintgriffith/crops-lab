"""TCP relay 127.0.0.1:18545 → LAN_RELAY (host:port). See lan_relay.py."""
import os, socket, threading

host, _, port = os.environ["LAN_RELAY"].partition(":")


def pipe(a, b):
    try:
        while (d := a.recv(65536)):
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass


srv = socket.create_server(("127.0.0.1", 18545), reuse_port=True)
while True:
    c, _ = srv.accept()
    u = socket.create_connection((host, int(port)), timeout=10)
    u.settimeout(None)
    threading.Thread(target=pipe, args=(c, u), daemon=True).start()
    threading.Thread(target=pipe, args=(u, c), daemon=True).start()
