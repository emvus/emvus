#!/usr/bin/env bash
# Measures the Ring1 parser against Ring0's: for every test source of Ring0 and every source of Ring1, the tree Ring1
# prints must equal `ring0 file` (the oracle). Prints the sources that differ and a summary.
# Usage: scripts/runCorpus.sh <emvusc> <ring0-binary> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
RING0="$(realpath "$2")"
WORK="$(realpath -m "$3")"
TESTS="$ROOT/../Ring0/tests"
cd "$ROOT"
source scripts/common.sh
mkdir -p "$WORK"
build "$EMVUSC" "$WORK/astTool" "${LEXER[@]}" "${PARSER[@]}" tests/astTool.ev
same=0
different=0
for file in "$TESTS"/lowering/*.ev "$TESTS"/syntax/p*.ev "$TESTS"/binding/*.ev "$TESTS"/flow/*.ev "$TESTS"/types/*.ev "$TESTS"/showcase.ev src/lexer/*.ev src/parser/*.ev src/parser/*/*.ev src/binder/*.ev src/binder/*/*.ev src/lowering/*.ev src/emvusc/*.ev tests/*.ev; do
    if ! "$RING0" "$file" > "$WORK/expected.txt" 2>/dev/null; then continue; fi
    "$WORK/astTool" "$file" > "$WORK/actual.txt" 2>&1 || true
    if cmp -s "$WORK/expected.txt" "$WORK/actual.txt"; then same=$((same + 1)); else different=$((different + 1)); echo "differs: $file"; fi
done
echo "identical: $same, different: $different"
[[ $different -eq 0 ]]
