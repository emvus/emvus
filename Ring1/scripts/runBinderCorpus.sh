#!/usr/bin/env bash
# Measures the Ring1 binder against Ring0's: for every test source Ring0 accepts, Ring1's type
# annotations must equal `ring0 file --check --types`. Prints the sources that differ.
# Usage: EMERALD_HOME=<kit> scripts/runBinderCorpus.sh <ring0-binary> <emerald-compiler> <novusc> <work-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
WORK="$4"
TESTS="$ROOT/../Ring0/tests"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
TOOL=("${LEXER[@]}" src/parser/*.ev src/parser/*/*.ev src/binder/*.ev)
cd "$ROOT"
mkdir -p "$WORK/types"
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
"$WORK/emvusToEmerald" "$RING0" "$WORK/types" "${TOOL[@]}" tests/emptyTest.ev
"$EMERALD" build "$WORK/types/Ring1Types.ems" -o "$WORK/types/run" > /dev/null
same=0
different=0
for file in "$TESTS"/lowering/*.ev "$TESTS"/types/*.ev "$TESTS"/flow/*.ev "$TESTS"/syntax/p*.ev "$TESTS"/showcase.ev; do
    if ! "$RING0" "$file" --check --types > "$WORK/types/expected.txt" 2>&1; then continue; fi
    head -n -2 "$WORK/types/expected.txt" > "$WORK/types/expected.body"
    "$WORK/types/run" "$file" 2>&1 | head -n -1 > "$WORK/types/actual.body"
    if cmp -s "$WORK/types/expected.body" "$WORK/types/actual.body"; then
        same=$((same + 1))
        continue
    fi
    different=$((different + 1))
    echo "differs: $(basename "$file")"
done
echo "identical: $same, different: $different"
