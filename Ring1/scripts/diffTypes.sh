#!/usr/bin/env bash
# Shows where the Ring1 binder's annotations differ from Ring0's `--check --types` for one program.
# The given files are joined into one program (the first file keeps its package line), the way Ring0
# builds several files, so both binders see the same text and the same line numbers.
# Usage: EMERALD_HOME=<kit> scripts/diffTypes.sh <ring0-binary> <emerald-compiler> <novusc> <work-dir> <file.ev>...
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
WORK="$4"
shift 4
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
TOOL=("${LEXER[@]}" src/parser/*.ev src/parser/*/*.ev src/binder/*.ev src/binder/*/*.ev)
cd "$ROOT"
mkdir -p "$WORK/types"
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
"$WORK/emvusToEmerald" "$RING0" "$WORK/types" "${TOOL[@]}" tests/emptyTest.ev
"$EMERALD" build "$WORK/types/Ring1Types.ems" -o "$WORK/types/run" > /dev/null
first=1
: > "$WORK/types/program.ev"
for file in "$@"; do
    if [[ $first -eq 1 ]]; then cat "$file" >> "$WORK/types/program.ev"; first=0; else grep -v '^package ' "$file" >> "$WORK/types/program.ev"; fi
done
diff <("$RING0" "$WORK/types/program.ev" --check --types | head -n -2) <("$WORK/types/run" "$WORK/types/program.ev" | head -n -1) && echo "identical"
