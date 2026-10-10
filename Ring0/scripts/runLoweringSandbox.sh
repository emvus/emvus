#!/usr/bin/env bash
# Emvus -> Sublang wire -> native program, all inside capped sandboxes.
#   stage A (Emerald toolchain): builds src/LoweringMain.ems together with the frontend and
#           the Sublang sources and lowers each .ev file to a .sublang-wire file
#   stage B (Sublang's own scripts/sublang-build.sh): wire -> LLVM -> native, optional run
# Emerald resolves `use` only below the entry file's directory, so stage A assembles the
# sources on the container's tmpfs; Ring0 and Sublang are mounted read-only and nothing is
# copied into either repository.
# Usage: scripts/runLoweringSandbox.sh [--run] [--dump] <file.ev>...   (paths relative to Ring0/)
#   --run   execute the native program and print its result (the entry's Int)
#   --dump  print the readable Sublang dump and verifier verdict instead of building
# Environment: RING0_BASE_SRC (dir containing ring0/, default: committed HEAD snapshot of the
#   frontend so concurrent edits cannot break a run), RING0_SUBLANG_CHECKOUT, RING0_LOWER_OUT.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMERALD_ROOT="${RING0_EMERALD_ROOT:-/run/media/syntaxjason/0A625B37625B272B/Code Space/Emerald/Emerald LLVM}"
SUBLANG_CHECKOUT="${RING0_SUBLANG_CHECKOUT:-$ROOT/../../../Emerald/Sublang}"
IMAGE="${RING0_SANDBOX_IMAGE:-emerald-selfhost-sandbox}"
RUN=0
DUMP=0
FILES=()
for arg in "$@"; do
    case "$arg" in
        --run) RUN=1 ;;
        --dump) DUMP=1 ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) FILES+=("$arg") ;;
    esac
done
if [[ ${#FILES[@]} -eq 0 ]]; then echo "No .ev file given" >&2; exit 2; fi
if [[ ! -d "$SUBLANG_CHECKOUT/src/sublang" ]]; then
    echo "Set RING0_SUBLANG_CHECKOUT to a Sublang checkout." >&2
    exit 2
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BASE_SRC="${RING0_BASE_SRC:-}"
if [[ -z "$BASE_SRC" ]]; then
    BASE_SRC="$WORK/base"
    mkdir -p "$BASE_SRC"
    git -C "$ROOT" archive HEAD src/ring0 | tar -x -C "$BASE_SRC" --strip-components=1
fi
OUT="${RING0_LOWER_OUT:-$WORK/out}"
mkdir -p "$OUT"
ARGS=()
for file in "${FILES[@]}"; do ARGS+=("/ring0/$file"); done
MODE=wire
if [[ $DUMP = 1 ]]; then MODE=dump; fi
docker run --rm --init --pull=never --network=none --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges --memory=6000000000 --memory-swap=6000000000 \
    --cpus=2 --pids-limit=128 --ulimit core=0 --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$ROOT,dst=/ring0,readonly" \
    --mount "type=bind,src=$BASE_SRC,dst=/base,readonly" \
    --mount "type=bind,src=$SUBLANG_CHECKOUT,dst=/sublang,readonly" \
    --mount "type=bind,src=$EMERALD_ROOT,dst=/emerald,readonly" \
    --mount "type=bind,src=$OUT,dst=/export" \
    --tmpfs /tmp:rw,exec,nosuid,size=1073741824 \
    -e HOME=/tmp -e EMERALD_HOME=/emerald \
    -e EMERALD_LLVM_LIB_DIR=/usr/lib -e EMERALD_LLVM_LIBRARY=LLVM \
    "$IMAGE" timeout --signal=TERM --kill-after=5s 420s sh -c '
      set -e
      mode=$1; shift
      mkdir /tmp/root
      cp -r /base/ring0 /tmp/root/ring0
      rm -rf /tmp/root/ring0/lowering
      cp -r /ring0/src/ring0/lowering /tmp/root/ring0/lowering
      cp /ring0/src/LoweringMain.ems /tmp/root/LoweringMain.ems
      cp -r /sublang/src/sublang /tmp/root/sublang
      timeout 240s /emerald/emerald-stable/emerald-compiler build /tmp/root/LoweringMain.ems -o /tmp/ring0-lower
      for file in "$@"; do
        name=$(basename "$file" .ev)
        echo "=== $name"
        if [ "$mode" = dump ]; then
          timeout 30s /tmp/ring0-lower --dump "$file" || echo "exit=$?"
        else
          timeout 30s /tmp/ring0-lower "$file" "/export/$name.sublang-wire" || echo "exit=$?"
        fi
      done
    ' sh "$MODE" "${ARGS[@]}"
if [[ $DUMP = 1 ]]; then exit 0; fi
for file in "${FILES[@]}"; do
    name="$(basename "$file" .ev)"
    if [[ ! -f "$OUT/$name.sublang-wire" ]]; then
        echo "=== $name: no wire produced"
        continue
    fi
    echo "=== $name: native"
    BUILD_ARGS=("$OUT/$name.sublang-wire" -o "$OUT/$name" --flow=auto --optimind=on)
    if [[ $RUN = 1 ]]; then BUILD_ARGS+=(--run); fi
    bash "$SUBLANG_CHECKOUT/scripts/sublang-build.sh" "${BUILD_ARGS[@]}" || echo "exit=$?"
done
