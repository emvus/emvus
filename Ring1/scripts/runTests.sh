#!/usr/bin/env bash
# Runs the Ring1 self tests on Emerald: Ring0 parses the sources (--ast), emvusToEmerald.nv (built with novusc) translates
# them, the Emerald compiler builds the result and the program prints the number of failed cases.
# Usage: EMERALD_HOME=<kit> scripts/runTests.sh <ring0-binary> <emerald-compiler> <novusc> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
WORK="$4"
cd "$ROOT"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
PARSER=(src/parser/*.ev src/parser/*/*.ev)
BINDER=(src/binder/*.ev src/binder/*/*.ev)
mkdir -p "$WORK"
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
status=0
run() {
    local name="$1"; shift
    "$WORK/emvusToEmerald" "$RING0" "$WORK/$name" "$@"
    "$EMERALD" build "$WORK/$name/Ring1Main.ems" -o "$WORK/$name/run" > /dev/null
    local result
    result="$("$WORK/$name/run" | tail -n 1)"
    echo "$name: $result"
    [[ "$result" == "failed cases: 0" ]] || status=1
}
run lexer "${LEXER[@]}" tests/lexerTest.ev
run parser "${LEXER[@]}" "${PARSER[@]}" tests/parserTest.ev
run nullFlow "${LEXER[@]}" "${PARSER[@]}" "${BINDER[@]}" tests/nullFlowTest.ev
exit $status
