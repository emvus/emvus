#!/usr/bin/env bash
# Runs the Ring1 lowering on Ring0's lowering fixtures: Ring1's Sublang text is built into a wire file,
# compiled natively and its output compared with the fixture's expected output. Fixtures that use
# constructs the lowering does not handle yet report "unsupported" and are counted separately.
# Usage: EMERALD_HOME=<kit> scripts/runLoweringCorpus.sh <ring0-binary> <emerald-compiler> <novusc> <sublang> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
SUBLANG="$4"
WORK="$5"
TESTS="$ROOT/../Ring0/tests"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
TOOL=("${LEXER[@]}" src/parser/*.ev src/parser/*/*.ev src/binder/*.ev src/binder/*/*.ev src/lowering/*.ev)
cd "$ROOT"
mkdir -p "$WORK/lower"
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
"$WORK/emvusToEmerald" "$RING0" "$WORK/lower" "${TOOL[@]}" tests/emptyTest.ev
"$EMERALD" build "$WORK/lower/Ring1Lower.ems" -o "$WORK/lower/run" > /dev/null
passed=0
failed=0
unsupported=0
for file in "$TESTS"/lowering/*.ev; do
    name="$(basename "$file" .ev)"
    expected="$TESTS/lowering/expected/$name.out"
    [[ -f "$expected" ]] || continue
    "$WORK/lower/run" "$file" > "$WORK/lower/$name.txt" 2>&1 || true
    if [[ "$(head -c 11 "$WORK/lower/$name.txt")" == "unsupported" ]]; then
        unsupported=$((unsupported + 1))
        continue
    fi
    if ! "$SUBLANG" text-build "$WORK/lower/$name.txt" "$WORK/lower/$name.wire" > "$WORK/lower/$name.build.log" 2>&1; then
        echo "FAIL $name: text-build: $(head -1 "$WORK/lower/$name.build.log")"
        failed=$((failed + 1))
        continue
    fi
    if ! EMERALD_FLOW_BOOTSTRAP=1 "$SUBLANG" emit-llvm "$WORK/lower/$name.wire" "$WORK/lower/$name.ll" auto on > "$WORK/lower/$name.emit.log" 2>&1; then
        echo "FAIL $name: emit-llvm: $(head -1 "$WORK/lower/$name.emit.log")"
        failed=$((failed + 1))
        continue
    fi
    clang -O2 -w "$WORK/lower/$name.ll" -o "$WORK/lower/$name.bin" 2> "$WORK/lower/$name.clang.log" || { echo "FAIL $name: clang"; failed=$((failed + 1)); continue; }
    actual="$("$WORK/lower/$name.bin" 2>&1 || true)"
    if [[ "$actual" == "$(cat "$expected")" ]]; then
        passed=$((passed + 1))
    else
        echo "FAIL $name: expected $(cat "$expected"), got $actual"
        failed=$((failed + 1))
    fi
done
echo "lowering: passed $passed, failed $failed, unsupported $unsupported"
[[ $failed -eq 0 ]]
