#!/usr/bin/env bash
# Runs the Ring1 self tests as native programs: each is built from Ring1's sources and a test with emvusc (Ring0) and
# clang, and prints the number of failed cases. The bootstrap test runs Ring1's frontend and lowering on a small
# program and compares the results with Ring0's and with the Emerald-hosted lowering's.
# Usage: scripts/runTests.sh <emvusc> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
WORK="$(realpath -m "$2")"
cd "$ROOT"
source scripts/common.sh
mkdir -p "$WORK"
status=0
run() {
    local name="$1"; shift
    build "$EMVUSC" "$WORK/$name" "$@"
    local result
    result="$("$WORK/$name")"
    echo "$name: failed cases: $result"
    [[ "$result" == "0" ]] || status=1
}
run lexer "${LEXER[@]}" tests/lexerTest.ev
run parser "${LEXER[@]}" "${PARSER[@]}" tests/parserTest.ev
run nullFlow "${LEXER[@]}" "${PARSER[@]}" "${BINDER[@]}" tests/nullFlowTest.ev
run bootstrap "${LEXER[@]}" "${PARSER[@]}" "${BINDER[@]}" "${LOWERING[@]}" tests/bootstrapTest.ev
exit $status
