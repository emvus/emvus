#!/usr/bin/env bash
# Runs the Ring1 tests as native programs, compiled by emvusc (Ring0 -> Sublang -> clang): the lexer
# tests, the parser tests and the parser corpus. Each program prints the number of failed cases.
# Usage: scripts/runNative.sh <emvusc> <ring0-binary> <novusc> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
RING0="$(realpath "$2")"
NOVUSC="$(realpath "$3")"
WORK="$(realpath -m "$4")"
TESTS="$ROOT/../Ring0/tests"
cd "$ROOT"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
PARSER=(src/parser/*.ev src/parser/*/*.ev)
mkdir -p "$WORK"
"$NOVUSC" build scripts/generateParserCases.nv -o "$WORK/generateParserCases" > /dev/null
"$WORK/generateParserCases" "$RING0" "$WORK/parserCorpus.ev" "$TESTS"/lowering/*.ev "$TESTS"/syntax/p*.ev "$TESTS"/binding/*.ev "$TESTS"/flow/*.ev "$TESTS"/types/*.ev "$TESTS"/showcase.ev src/lexer/*.ev src/parser/*.ev src/parser/*/*.ev tests/lexerTest.ev > /dev/null
status=0
run() {
    local name="$1"; shift
    "$EMVUSC" "$@" -o "$WORK/$name"
    local result
    result="$("$WORK/$name")"
    echo "$name: failed cases: $result"
    [[ "$result" == "0" ]] || status=1
}
run lexer "${LEXER[@]}" tests/lexerTest.ev
run parser "${LEXER[@]}" "${PARSER[@]}" tests/parserTest.ev
run corpus "${LEXER[@]}" "${PARSER[@]}" "$WORK/parserCorpus.ev"
exit $status
