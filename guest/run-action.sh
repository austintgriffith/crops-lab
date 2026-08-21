#!/bin/bash
# run-action.sh — runs INSIDE the guest, invoked by `lab run` via `tart exec`.
# The guest agent already executes us as admin inside the Aqua session, so
# headed Chrome gets a window with no launchctl gymnastics. Secrets come from
# ~/lab/.env (Tier 3, mode 600); run parameters from ~/lab/run.env.
set -uo pipefail
ACTION="${1:?usage: run-action.sh <action>}"
LAB="$HOME/lab"
[[ -f "$LAB/actions/$ACTION.js" ]] || { echo "no $LAB/actions/$ACTION.js" >&2; exit 2; }
mkdir -p "$LAB/out"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
[[ -f "$LAB/.env" ]]    && . "$LAB/.env"
[[ -f "$LAB/run.env" ]] && . "$LAB/run.env"
set +a
cd "$LAB"
node "actions/$ACTION.js" 2>&1 | tee -a "$LAB/out/driver.log"
exit "${PIPESTATUS[0]}"
