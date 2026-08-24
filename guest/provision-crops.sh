#!/bin/bash
# provision-crops.sh — runs INSIDE the crops VM. Shipped + invoked by `lab`
# (host side); do not run on the host.
#
# Layered exactly like clawd-containers' provisioners: this file sources the
# clean-mac layer below it (clawd-containers/provision.sh — brew, Chrome,
# quarantine strip, iTerm/dock tidy), then adds the lab's own tiers. Any tier
# is idempotent; re-running is always safe.
#
#   Tier 1  provision.sh (clawd-containers)   baked into crops-gold
#   Tier 2  node + playwright + Chrome policy   baked into crops-gold
#   Tier 3  mitm CA, system proxy → host,       re-applied EVERY run (FAST mode)
#           actions/, wallet/, throwaway env
#
# Modes (set by `lab` in the env it passes):
#   CROPS_FAST=1   skip Tier 1+2 — the VM was cloned from crops-gold
#   CROPS_BAKE=1   building gold: run Tier 1+2, but NEVER ship/keep secrets.
#                  Gold must be identity-free — clawd-containers learned this
#                  the hard way (2026-07-07: a baked env made every clone run
#                  as a stale identity). The throwaway key is Tier 3 only.
#
# Inputs staged by `lab` into /tmp/crops/ (one tar stream):
#   provision.sh            clawd-containers Tier 1 (copied from its checkout)
#   mitm-ca-cert.pem        the lab's mitm CA *certificate* (public half only)
#   run.env                 HOST_PROXY / PROXY_PORT / RUN_ID (non-secret)
#   actions/                Playwright drivers
#   wallet/<name>/          unpacked extension(s), if present on the host
#   .env.crops              throwaway WALLET_PK etc. — FAST/run only, never bake
set -euo pipefail

STAGE=/tmp/crops
LAB="$HOME/lab"
FAST="${CROPS_FAST:-}"
BAKE="${CROPS_BAKE:-}"

echo "==> crops layer: $(whoami)@$(hostname) ($(sw_vers -productName) $(sw_vers -productVersion)) fast=${FAST:-0} bake=${BAKE:-0}"

# ── Tier 1: clean mac (clawd-containers/provision.sh) ───────────────────
# It honours CONT_PROVISION_FAST the same way we honour CROPS_FAST, and in
# FAST mode still exports brew's PATH for us.
if [[ -f "$STAGE/provision.sh" ]]; then
  CONT_PROVISION_FAST="${FAST:+1}" source "$STAGE/provision.sh"
else
  echo "WARN: $STAGE/provision.sh missing — Tier 1 skipped (is CONT_DIR right on the host?)" >&2
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
fi

# ── Tier 2: node + playwright + Chrome policy (gold) ────────────────────
if [[ "$FAST" != "1" ]]; then
  echo "==> tier 2: node"
  brew list node >/dev/null 2>&1 || brew install node

  echo "==> tier 2: playwright"
  mkdir -p "$LAB"
  ( cd "$LAB"
    [[ -f package.json ]] || npm init -y >/dev/null
    # Exact version is pinned by the package-lock this writes; `lab bake`
    # copies the resolved versions into gold-manifest.txt on the host.
    npm ls playwright >/dev/null 2>&1 || npm i --no-audit --no-fund playwright >/dev/null
    # Bundled Chromium — REQUIRED for wallet actions. Google Chrome 128+
    # blocks --load-extension from the command line (verified dead on Chrome
    # 151), so an unpacked MetaMask can't be loaded into channel:'chrome'.
    # Chromium shares Chrome's network stack, so the wallet's request traffic
    # is identical; only wallet actions use it, smoke still uses real Chrome.
    npx --yes playwright install chromium >/dev/null 2>&1 || echo "WARN: playwright chromium install failed" >&2
  )

  # Chrome managed policy: no QUIC/HTTP-3 anywhere in this guest, so nothing
  # can skip the TCP proxy. Belt (policy, covers every Chrome launch incl.
  # extension service workers) + suspenders (Playwright also passes
  # --disable-quic). Anything still on udp/443 shows in the pcap = finding.
  echo "==> tier 2: Chrome policy QuicAllowed=false"
  defaults write com.google.Chrome QuicAllowed -bool false
  # Don't let Chrome phone home for the first-run/sign-in dance mid-capture.
  defaults write com.google.Chrome BrowserSignin -int 0
  defaults write com.google.Chrome MetricsReportingEnabled -bool false
  defaults write com.google.Chrome PromotionsEnabled -bool false
fi

# ── Tier 3: per-run volatile state ──────────────────────────────────────
mkdir -p "$LAB"

# Non-secret run parameters from the host (proxy address is derived on the
# host from bridge100 at run time — never hardcoded in a baked image).
HOST_PROXY=""; PROXY_PORT=""
if [[ -f "$STAGE/run.env" ]]; then
  # shellcheck disable=SC1090
  source "$STAGE/run.env"
  install -m 644 "$STAGE/run.env" "$LAB/run.env"
fi

# 3a. Trust the lab's mitm CA in the System keychain (every TLS client on the
# box honours it: Chrome, native apps, curl). Idempotent: remove any prior
# cert with the same common name first so a rotated CA replaces, not stacks.
if [[ -f "$STAGE/mitm-ca-cert.pem" ]]; then
  echo "==> tier 3: trust mitm CA (System keychain)"
  CN="$(openssl x509 -noout -subject -in "$STAGE/mitm-ca-cert.pem" 2>/dev/null | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p')"
  if [[ -n "$CN" ]]; then
    while echo admin | sudo -S security delete-certificate -c "$CN" /Library/Keychains/System.keychain >/dev/null 2>&1; do :; done
  fi
  echo admin | sudo -S security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "$STAGE/mitm-ca-cert.pem"
  install -m 644 "$STAGE/mitm-ca-cert.pem" "$LAB/mitm-ca-cert.pem"
  # Verify it actually landed — a silent failure here makes every HTTPS body
  # opaque and the whole run worthless.
  security find-certificate -c "${CN:-mitmproxy}" /Library/Keychains/System.keychain >/dev/null \
    || { echo "ERROR: mitm CA not found in System keychain after add" >&2; exit 1; }
elif [[ "$BAKE" != "1" ]]; then
  echo "ERROR: $STAGE/mitm-ca-cert.pem missing — HTTPS would be opaque; aborting" >&2
  exit 1
fi

# 3b. System proxy → host mitmproxy, on every network service. Covers native
# apps and Chrome's background/extension traffic, not just the tab Playwright
# drives. At bake time there is no proxy to point at, so skip.
if [[ -n "$HOST_PROXY" && -n "$PROXY_PORT" ]]; then
  echo "==> tier 3: system proxy -> $HOST_PROXY:$PROXY_PORT"
  networksetup -listallnetworkservices | tail -n +2 | sed 's/^\*//' | while read -r svc; do
    [[ -n "$svc" ]] || continue
    networksetup -setwebproxy "$svc" "$HOST_PROXY" "$PROXY_PORT" 2>/dev/null || true
    networksetup -setsecurewebproxy "$svc" "$HOST_PROXY" "$PROXY_PORT" 2>/dev/null || true
    networksetup -setproxybypassdomains "$svc" "Empty" 2>/dev/null || true
  done
  # Also pin it as Chrome policy so Chrome cannot be talked out of it.
  defaults write com.google.Chrome ProxyMode -string fixed_servers
  defaults write com.google.Chrome ProxyServer -string "$HOST_PROXY:$PROXY_PORT"
elif [[ "$BAKE" == "1" ]]; then
  echo "==> tier 3: bake — no proxy set (gold stays proxy-free)"
fi

# 3c. Runner, actions, wallet extension(s). Installed under ~/lab because
# the staging dir is wiped at the end of this script.
install -m 755 "$STAGE/run-action.sh" "$LAB/run-action.sh"
if [[ -d "$STAGE/actions" ]]; then
  echo "==> tier 3: actions/"
  rm -rf "$LAB/actions"; cp -R "$STAGE/actions" "$LAB/actions"
fi
if [[ -d "$STAGE/wallet" ]]; then
  echo "==> tier 3: wallet/ ($(ls "$STAGE/wallet" | tr '\n' ' '))"
  rm -rf "$LAB/wallet"; cp -R "$STAGE/wallet" "$LAB/wallet"
fi

# 3d. Throwaway secrets — run only. Refuse to keep them in a bake.
if [[ "$BAKE" == "1" ]]; then
  rm -f "$STAGE/.env.crops" "$LAB/.env"
  echo "==> tier 3: bake — secrets skipped (gold is identity-free)"
elif [[ -f "$STAGE/.env.crops" ]]; then
  echo "==> tier 3: ~/lab/.env (mode 600)"
  install -m 600 "$STAGE/.env.crops" "$LAB/.env"
  rm -f "$STAGE/.env.crops"
fi

# Fresh Chrome profile dir per run (never reuse — a profile is identity).
rm -rf "$LAB/profile"; mkdir -p "$LAB/profile" "$LAB/out"

rm -rf "$STAGE"
# tart stop is not always graceful; unsynced writes have rolled back before.
sync
echo "==> crops layer: done"
