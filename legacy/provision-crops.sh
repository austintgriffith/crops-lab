#!/bin/bash
# provision-crops.sh — runs INSIDE the crops VM via:  cont provision crops ./provision-crops.sh
# Idempotent. Makes the guest capture-ready: trust the host's mitm CA, route all
# traffic to the host proxy, install Chrome + node/playwright. The wallet extension
# and the throwaway key are NOT baked here — injected per run.
set -euo pipefail
HOST_PROXY="${HOST_PROXY:-192.168.64.1}"     # bridge100 on the host
PROXY_PORT="${PROXY_PORT:-8080}"
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
export HOMEBREW_CASK_OPTS="--no-quarantine"

echo "==> chrome + node"
brew list --cask google-chrome >/dev/null 2>&1 || brew install --cask google-chrome
brew list node >/dev/null 2>&1 || brew install node
sudo xattr -dr com.apple.quarantine "/Applications/Google Chrome.app" 2>/dev/null || true

echo "==> trust mitm CA (scp'd to /tmp/mitm-ca.pem by the host harness)"
if [[ -f /tmp/mitm-ca.pem ]]; then
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/mitm-ca.pem
  echo "    CA trusted (System keychain)"
else
  echo "    WARN: /tmp/mitm-ca.pem missing — HTTPS bodies will be opaque"
fi

echo "==> system proxy -> host mitmproxy (every network service)"
networksetup -listallnetworkservices | tail -n +2 | while read -r svc; do
  networksetup -setwebproxy "$svc" "$HOST_PROXY" "$PROXY_PORT" 2>/dev/null || true
  networksetup -setsecurewebproxy "$svc" "$HOST_PROXY" "$PROXY_PORT" 2>/dev/null || true
done

echo "==> playwright (drives the real Chrome; extensions need headed)"
mkdir -p "$HOME/lab" && cd "$HOME/lab"
[[ -f package.json ]] || npm init -y >/dev/null
npm ls playwright >/dev/null 2>&1 || npm i playwright@1.47 >/dev/null

echo "==> done — snapshot this as gold:  cont snapshot crops crops-gold && cont base crops-gold"
