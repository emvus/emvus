#!/usr/bin/env bash
# Builds emvusc written in Emvus (Ring1) with an existing emvusc: stage 1 is compiled by the Emerald-built emvusc
# (Ring0), stage 2 by stage 1, and the two must produce the same Sublang text for the compiler's own sources.
# Usage: scripts/buildEmvuscRing1.sh <ring0-emvusc> <sublang> <out-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0_EMVUSC="$(realpath "$1")"
SUBLANG="$(realpath "$2")"
OUT="$(realpath -m "$3")"
cd "$ROOT"
SOURCES=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev src/parser/*.ev src/parser/*/*.ev src/binder/*.ev src/binder/*/*.ev src/lowering/*.ev src/emvusc/*.ev)
mkdir -p "$OUT"
native() {
    local text="$1" name="$2"
    "$SUBLANG" text-build "$text" "$OUT/$name.sublang-wire" > /dev/null
    EMERALD_FLOW_BOOTSTRAP=1 "$SUBLANG" emit-llvm "$OUT/$name.sublang-wire" "$OUT/$name.ll" auto on > /dev/null
    clang -O2 -w "$OUT/$name.ll" -o "$OUT/$name"
}
echo "stage 1: Ring0 emvusc compiles Ring1"
"$RING0_EMVUSC" --emit-wire "${SOURCES[@]}" -o "$OUT/stage1.sublang-wire" > /dev/null
EMERALD_FLOW_BOOTSTRAP=1 "$SUBLANG" emit-llvm "$OUT/stage1.sublang-wire" "$OUT/stage1.ll" auto on > /dev/null
clang -O2 -w "$OUT/stage1.ll" -o "$OUT/stage1"
echo "stage 2: stage 1 compiles Ring1"
"$OUT/stage1" "${SOURCES[@]}" -o "$OUT/stage2.sublang-text" > /dev/null
native "$OUT/stage2.sublang-text" stage2
echo "stage 3: stage 2 compiles Ring1"
"$OUT/stage2" "${SOURCES[@]}" -o "$OUT/stage3.sublang-text" > /dev/null
if cmp -s "$OUT/stage2.sublang-text" "$OUT/stage3.sublang-text"; then
    cp "$OUT/stage2" "$OUT/emvusc"
    echo "fixed point reached: $OUT/emvusc"
else
    echo "stage 2 and stage 3 differ"
    exit 1
fi
