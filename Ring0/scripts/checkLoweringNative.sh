#!/usr/bin/env bash
# Compiles every tests/lowering/*.ev to a native program through Sublang and compares the output with
# tests/lowering/expected/<name>.out, like checkLowering.sh but without the Docker sandbox.
#   Ring0 (ring0-lower) -> .sublang-wire -> sublang emit-llvm -> clang -> run
# First-line markers: `// expect-error: <text>` (Ring0 must reject), `// expect-abort` (exit 134),
# `// expect-backend-crash` (Sublang's emit-llvm is expected to fail).
# Usage: scripts/checkLoweringNative.sh <ring0-lower> <sublang> <work-dir> [fixture-name...]
set -uo pipefail
export EMERALD_FLOW_BOOTSTRAP=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOWER="$1"
SUBLANG="$2"
WORK="$3"
shift 3
mkdir -p "$WORK"
status=0
passed=0
if [[ $# -gt 0 ]]; then FILES=(); for name in "$@"; do FILES+=("$ROOT/tests/lowering/$name.ev"); done; else FILES=("$ROOT"/tests/lowering/*.ev); fi
for source in "${FILES[@]}"; do
    name="$(basename "$source" .ev)"
    first="$(sed -n '1p' "$source")"
    wire="$WORK/$name.sublang-wire"
    rm -f "$wire" "$WORK/$name.ll" "$WORK/$name"
    output="$("$LOWER" "$source" "$wire" 2>&1)"
    if [[ "$first" == "// expect-error: "* ]]; then
        if grep -qF -- "${first#// expect-error: }" <<< "$output"; then passed=$((passed + 1)); else echo "FAIL $name: expected error '${first#// expect-error: }'"; status=1; fi
        continue
    fi
    if [[ ! -f "$wire" ]]; then echo "FAIL $name: no wire: $(head -1 <<< "$output")"; status=1; continue; fi
    if ! "$SUBLANG" emit-llvm "$wire" "$WORK/$name.ll" auto on > "$WORK/$name.emit.log" 2>&1; then
        if [[ "$first" == "// expect-backend-crash" ]]; then echo "ok   $name (emit-llvm fails as marked)"; passed=$((passed + 1)); else echo "FAIL $name: emit-llvm: $(head -1 "$WORK/$name.emit.log")"; status=1; fi
        continue
    fi
    if ! clang -O2 -w "$WORK/$name.ll" -o "$WORK/$name" 2> "$WORK/$name.clang.log"; then echo "FAIL $name: clang: $(head -1 "$WORK/$name.clang.log")"; status=1; continue; fi
    actual="$(timeout 20 "$WORK/$name" 2>&1)"
    code=$?
    if [[ "$first" == "// expect-abort" ]]; then
        if [[ $code -eq 134 ]]; then passed=$((passed + 1)); else echo "FAIL $name: expected abort (134), exit $code"; status=1; fi
        continue
    fi
    if [[ "$first" == "// expect-backend-crash" ]]; then echo "NOTE $name: the marked backend crash does not reproduce (exit $code)"; passed=$((passed + 1)); continue; fi
    expected="$(cat "$ROOT/tests/lowering/expected/$name.out" 2>/dev/null)"
    if [[ "$actual" == "$expected" ]]; then passed=$((passed + 1)); else echo "FAIL $name: expected '$expected', got '$actual' (exit $code)"; status=1; fi
done
echo "passed: $passed of ${#FILES[@]}"
exit $status
