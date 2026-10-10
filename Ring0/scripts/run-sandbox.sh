#!/usr/bin/env bash
# Baut src/Main.ems in der Sandbox (6 GB RAM, kein Swap, kein Netz) und führt es mit den Argumenten aus.
# Usage: scripts/run-sandbox.sh <datei.ev> [weitere Args]   (Pfad relativ zu Ring0/ oder absolut unter Ring0/)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMERALD_ROOT="${RING0_EMERALD_ROOT:-/run/media/syntaxjason/0A625B37625B272B/Code Space/Emerald/Emerald LLVM}"
IMAGE="${RING0_SANDBOX_IMAGE:-emerald-selfhost-sandbox}"
ARGS=()
for a in "$@"; do
    case "$a" in /*|-*) ARGS+=("$a") ;; *) ARGS+=("/project/$a") ;; esac
done
docker run --rm --init --network=none --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges --memory=6000000000 --memory-swap=6000000000 \
    --cpus=2 --pids-limit=128 --ulimit core=0 --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$ROOT,dst=/project,readonly" \
    --mount "type=bind,src=$EMERALD_ROOT,dst=/emerald,readonly" \
    --tmpfs /tmp:rw,exec,nosuid,size=1073741824 \
    -e HOME=/tmp -e EMERALD_HOME=/emerald \
    -e EMERALD_LLVM_LIB_DIR=/usr/lib -e EMERALD_LLVM_LIBRARY=LLVM \
    "$IMAGE" timeout --signal=TERM --kill-after=5s 300s sh -c '
      set -e
      timeout 180s /emerald/emerald-stable/emerald-compiler build /project/src/Main.ems -o /tmp/ring0
      shift_args="$@"
      timeout 30s /tmp/ring0 "$@"
    ' sh "${ARGS[@]}"
