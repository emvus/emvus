#!/usr/bin/env bash
# Measures the Ring1 parser against Ring0's test sources and Ring1's own sources: the generated cases compare the tree printed
# by Ring1 with the one printed by Ring0 (the oracle). Prints the failing cases and a summary.
# Usage: EMERALD_HOME=<kit> scripts/runCorpus.sh <ring0-binary> <emerald-compiler> <novusc> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
WORK="$4"
TESTS="$ROOT/../Ring0/tests"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
PARSER=(src/parser/*.ev src/parser/*/*.ev)
cd "$ROOT"
mkdir -p "$WORK/corpus"
"$NOVUSC" build scripts/generateParserCases.nv -o "$WORK/generateParserCases" > /dev/null
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
"$WORK/generateParserCases" "$RING0" "$WORK/corpus/parserCorpus.ev" "$TESTS"/lowering/*.ev "$TESTS"/syntax/p*.ev "$TESTS"/binding/*.ev "$TESTS"/flow/*.ev "$TESTS"/types/*.ev "$TESTS"/showcase.ev src/lexer/*.ev src/parser/*.ev src/parser/*/*.ev tests/lexerTest.ev
"$WORK/emvusToEmerald" "$RING0" "$WORK/corpus" "${LEXER[@]}" "${PARSER[@]}" "$WORK/corpus/parserCorpus.ev"
"$EMERALD" build "$WORK/corpus/Ring1Main.ems" -o "$WORK/corpus/run" > /dev/null
rm -f "$WORK/corpus/dump"
"$WORK/corpus/run" > "$WORK/corpus/result.txt"
grep ': 1$' "$WORK/corpus/result.txt" || true
echo "passed: $(grep -c ': 0$' "$WORK/corpus/result.txt"), failed: $(grep -c ': 1$' "$WORK/corpus/result.txt")"
