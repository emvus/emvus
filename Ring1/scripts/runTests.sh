#!/usr/bin/env bash
# Runs the Ring1 self tests on Emerald: Ring0 parses the sources (--ast), emvusToEmerald.py translates
# them, the Emerald compiler builds the result and the program prints the number of failed cases.
# Usage: EMERALD_HOME=<kit> scripts/runTests.sh <ring0-binary> <emerald-compiler> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
WORK="$3"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
PARSER=(src/parser/nodeTable.ev src/parser/tokenReader.ev src/parser/expressions.ev src/parser/statements.ev src/parser/declarations.ev src/parser/treeDump.ev src/parser/parser.ev)
cd "$ROOT"
status=0
run() {
    local name="$1"; shift
    python3 scripts/emvusToEmerald.py "$RING0" "$WORK/$name" "$@"
    "$EMERALD" build "$WORK/$name/Ring1Main.ems" -o "$WORK/$name/run" > /dev/null
    local result
    result="$("$WORK/$name/run")"
    echo "$name: $result"
    [[ "$result" == "failed cases: 0" ]] || status=1
}
run lexer "${LEXER[@]}" tests/lexerTest.ev
run parser "${LEXER[@]}" "${PARSER[@]}" tests/parserTest.ev
exit $status
