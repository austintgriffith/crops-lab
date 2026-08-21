#!/usr/bin/env bash
# One capture run on the HOST. Boots a clean macOS VM (cont/tart), taps its
# traffic from outside the guest, runs one action, collects into out/<run-id>/.
#
#   ACTION=send-eth ./run.sh
#
# Reuses ~/clawd/clawd-containers (cont). Secrets (mitm CA, throwaway key) are
# host-side and injected at run time — never in a VM image or snapshot.
set -euo pipefail

ACTION="${ACTION:?set ACTION, e.g. send-eth}"
VM="${VM:-crops}"
RUN_ID="${RUN_ID:-$(date +%s)}"
OUT="$(cd "$(dirname "$0")" && pwd)/out/${RUN_ID}"
CONT="${CONT:-$HOME/clawd/clawd-containers/cont}"
IFACE="${VMNET_IFACE:-bridge100}"   # tart NAT bridge on this host: 192.168.64.1 (guest 192.168.64.2)
mkdir -p "$OUT"
echo "run $RUN_ID  action=$ACTION  vm=$VM  out=$OUT"

# 1. clean, identical VM every run (the reproducibility win cont gives us)
"$CONT" reset "$VM"
"$CONT" up "$VM"
GUEST_IP="$(tart ip "$VM" --wait 60)"
echo "guest $GUEST_IP"

# 2. host-side capture — OUTSIDE the guest
if [ -n "$IFACE" ]; then
  sudo tcpdump -i "$IFACE" -w "$OUT/session.pcap" -U "host $GUEST_IP" >/dev/null 2>&1 &
  TCPDUMP=$!
else
  echo "WARN: VMNET_IFACE unset — pcap skipped (PLAN build-order step 1)"; TCPDUMP=
fi
CROPS_OUT="$OUT" mitmdump --mode regular --listen-port 8080 \
  -s "$(dirname "$0")/capture/flow_logger.py" \
  >"$OUT/mitm.log" 2>&1 &
MITM=$!
sleep 2

# 3. drive one action in the guest (guest already proxied → host:8080, CA trusted, quic off)
ACTION="$ACTION" GUEST_IP="$GUEST_IP" "$CONT" ssh "$VM" \
  "node /Users/admin/lab/actions/${ACTION}.js" 2>"$OUT/driver.log" \
  || echo "action exited nonzero (see driver.log)"

# 4. teardown
kill "$MITM" ${TCPDUMP:+$TCPDUMP} 2>/dev/null || true
"$CONT" suspend "$VM" 2>/dev/null || true

# 5. audit: SNIs on the wire but not decrypted = bypass/pinned = a finding
echo "--- summary ($RUN_ID) ---"
echo "flows: $(wc -l < "$OUT/flows.jsonl" 2>/dev/null || echo 0)"
echo "wrote $OUT/"
