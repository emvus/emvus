#!/usr/bin/env bash
# Compiles every tests/lowering/*.ev to a native program through Sublang and compares the output with
# tests/lowering/expected/<name>.out, like checkLowering.sh but without the Docker sandbox.
#   emvusc (Ring0 -> Sublang -> LLVM text) -> clang -> run
# First-line markers: `// expect-error: <text>` (Ring0 must reject), `// expect-abort` (exit 134),
# `// expect-backend-crash` (the Sublang backend inside emvusc is expected to fail).
# Usage: scripts/checkLoweringNative.sh <emvusc> <work-dir> [fixture-name...]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
WORK="$2"
shift 2
mkdir -p "$WORK"
status=0
passed=0
if [[ $# -gt 0 ]]; then FILES=(); for name in "$@"; do FILES+=("$ROOT/tests/lowering/$name.ev"); done; else FILES=("$ROOT"/tests/lowering/*.ev); fi
for source in "${FILES[@]}"; do
    name="$(basename "$source" .ev)"
    first="$(sed -n '1p' "$source")"
    llvm="$WORK/$name.ll"
    rm -f "$llvm" "$WORK/$name"
    output="$("$EMVUSC" "$source" -o "$llvm" 2>&1)"
    if [[ "$first" == "// expect-error: "* ]]; then
        if grep -qF -- "${first#// expect-error: }" <<< "$output"; then passed=$((passed + 1)); else echo "FAIL $name: expected error '${first#// expect-error: }'"; status=1; fi
        continue
    fi
    if [[ ! -f "$llvm" ]]; then
        if [[ "$first" == "// expect-backend-crash" ]]; then echo "ok   $name (the backend fails as marked)"; passed=$((passed + 1)); else echo "FAIL $name: $(head -1 <<< "$output")"; status=1; fi
        continue
    fi
    if ! clang -O2 -w "$WORK/$name.ll" -o "$WORK/$name" 2> "$WORK/$name.clang.log"; then echo "FAIL $name: clang: $(head -1 "$WORK/$name.clang.log")"; status=1; continue; fi
    # A program that reaches the platform (`// expect-status: N`) exits with main's Int. platformFiles also gets
    # two file arguments and is judged by the file it writes.
    arguments=()
    if [[ "$name" == "platformFiles" ]]; then
        printf 'platform file\n' > "$WORK/platform.in"
        rm -f "$WORK/platform.out"
        arguments=("$WORK/platform.in" "$WORK/platform.out")
    fi
    actual="$(timeout 20 "$WORK/$name" "${arguments[@]}" 2>&1)"
    code=$?
    if [[ "$first" == "// expect-status: "* ]]; then
        expected="$(cat "$ROOT/tests/lowering/expected/$name.out" 2>/dev/null)"
        if [[ "$name" == "platformFiles" ]]; then actual="$(cat "$WORK/platform.out" 2>/dev/null)"; expected="$(printf 'platform file\n!')"; fi
        if [[ $code -eq ${first#// expect-status: } && "$actual" == "$expected" ]]; then passed=$((passed + 1)); else echo "FAIL $name: expected status ${first#// expect-status: } and '$expected', got $code and '$actual'"; status=1; fi
        continue
    fi
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
