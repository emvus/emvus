#!/usr/bin/env bash
# The bootstrap check: Ring1's lexer, parser, binder and lowering are lowered by Ring1's own lowering (running on
# Emerald), built into a native program and run on a small source. The program's tests compare the type
# annotations with Ring0's and the lowered text with what the Emerald-hosted lowering produces. The program
# prints the number of failed checks.
# Usage: EMERALD_HOME=<kit> scripts/runBootstrap.sh <ring0-binary> <emerald-compiler> <novusc> <sublang> <work-dir>
set -euo pipefail
trap 'echo "bootstrap: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RING0="$1"
EMERALD="$2"
NOVUSC="$3"
SUBLANG="$4"
WORK="$5"
cd "$ROOT"
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
SOURCES=("${LEXER[@]}" src/parser/*.ev src/parser/*/*.ev src/binder/*.ev src/binder/*/*.ev src/lowering/*.ev)
mkdir -p "$WORK/bootstrap"
"$NOVUSC" build scripts/emvusToEmerald.nv -o "$WORK/emvusToEmerald" > /dev/null
"$WORK/emvusToEmerald" "$RING0" "$WORK/bootstrap" "${SOURCES[@]}" tests/emptyTest.ev
if ! "$EMERALD" build "$WORK/bootstrap/Ring1Lower.ems" -o "$WORK/bootstrap/lower" > "$WORK/bootstrap/build.log" 2>&1; then
    cat "$WORK/bootstrap/build.log" >&2
    exit 1
fi
first=1
: > "$WORK/bootstrap/program.ev"
for file in "${SOURCES[@]}" tests/bootstrapTest.ev; do
    if [[ $first -eq 1 ]]; then cat "$file" >> "$WORK/bootstrap/program.ev"; first=0; else grep -v '^package ' "$file" >> "$WORK/bootstrap/program.ev"; fi
done
"$WORK/bootstrap/lower" "$WORK/bootstrap/program.ev" | head -n -1 > "$WORK/bootstrap/program.txt"
if [[ "$(head -c 11 "$WORK/bootstrap/program.txt")" == "unsupported" ]]; then echo "the lowering cannot lower itself: $(head -1 "$WORK/bootstrap/program.txt")"; exit 1; fi
"$SUBLANG" text-build "$WORK/bootstrap/program.txt" "$WORK/bootstrap/program.wire" > /dev/null
EMERALD_FLOW_BOOTSTRAP=1 "$SUBLANG" emit-llvm "$WORK/bootstrap/program.wire" "$WORK/bootstrap/program.ll" auto on > /dev/null
clang -O2 -w "$WORK/bootstrap/program.ll" -o "$WORK/bootstrap/program"
failed="$("$WORK/bootstrap/program")"
echo "bootstrap: failed checks: $failed"
[[ "$failed" == "0" ]]
