#!/usr/bin/env bash
# Runs the Ring1 lowering (through emvusc written in Emvus) on Ring0's lowering fixtures: Ring1's Sublang text is
# built into a program and its output compared with the fixture's expected output. Fixtures that use constructs
# the lowering does not handle yet report "unsupported" and are counted separately.
# Usage: scripts/runLoweringCorpus.sh <ring1-emvusc> <sublang> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
SUBLANG="$(realpath "$2")"
WORK="$(realpath -m "$3")"
TESTS="$ROOT/../Ring0/tests/lowering"
mkdir -p "$WORK"
passed=0
failed=0
unsupported=0
for file in "$TESTS"/*.ev; do
    name="$(basename "$file" .ev)"
    expected="$TESTS/expected/$name.out"
    first="$(head -n 1 "$file")"
    [[ -f "$expected" && "$first" != "// expect-status: "* ]] || continue
    if ! "$EMVUSC" "$file" -o "$WORK/$name.sublang-text" > "$WORK/$name.log" 2>&1; then unsupported=$((unsupported + 1)); continue; fi
    if ! "$SUBLANG" text-build "$WORK/$name.sublang-text" "$WORK/$name.sublang-wire" > "$WORK/$name.build.log" 2>&1; then echo "FAIL $name: text-build: $(head -1 "$WORK/$name.build.log")"; failed=$((failed + 1)); continue; fi
    if ! EMERALD_FLOW_BOOTSTRAP=1 "$SUBLANG" emit-llvm "$WORK/$name.sublang-wire" "$WORK/$name.ll" auto on > "$WORK/$name.emit.log" 2>&1; then echo "FAIL $name: emit-llvm: $(head -1 "$WORK/$name.emit.log")"; failed=$((failed + 1)); continue; fi
    clang -O2 -w "$WORK/$name.ll" -o "$WORK/$name.bin" 2> "$WORK/$name.clang.log" || { echo "FAIL $name: clang"; failed=$((failed + 1)); continue; }
    actual="$("$WORK/$name.bin" 2>&1 || true)"
    if [[ "$actual" == "$(cat "$expected")" ]]; then passed=$((passed + 1)); else echo "FAIL $name: expected $(cat "$expected"), got $actual"; failed=$((failed + 1)); fi
done
echo "lowering: passed $passed, failed $failed, unsupported $unsupported"
[[ $failed -eq 0 ]]
