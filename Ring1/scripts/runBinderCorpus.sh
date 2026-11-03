#!/usr/bin/env bash
# Measures the Ring1 binder against Ring0's: for every test source Ring0 accepts, the annotations Ring1 prints must equal
# `ring0 file --check --types`. Prints the sources that differ. With file arguments, only those (joined into one
# program) are compared and the first differences are shown.
# Usage: scripts/runBinderCorpus.sh <emvusc> <ring0-binary> <work-dir> [file.ev...]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
RING0="$(realpath "$2")"
WORK="$(realpath -m "$3")"
shift 3
TESTS="$ROOT/../Ring0/tests"
cd "$ROOT"
source scripts/common.sh
mkdir -p "$WORK"
build "$EMVUSC" "$WORK/typesTool" "${LEXER[@]}" "${PARSER[@]}" "${BINDER[@]}" tests/typesTool.ev
if [[ $# -gt 0 ]]; then
    join "$WORK/program.ev" "$@"
    diff <("$RING0" "$WORK/program.ev" --check --types | head -n -2) <("$WORK/typesTool" "$WORK/program.ev") && echo "identical"
    exit
fi
same=0
different=0
for file in "$TESTS"/lowering/*.ev "$TESTS"/types/*.ev "$TESTS"/flow/*.ev "$TESTS"/syntax/p*.ev "$TESTS"/showcase.ev; do
    if ! "$RING0" "$file" --check --types > "$WORK/expected.txt" 2>&1; then continue; fi
    head -n -2 "$WORK/expected.txt" > "$WORK/expected.body"
    "$WORK/typesTool" "$file" > "$WORK/actual.body" 2>&1 || true
    if cmp -s "$WORK/expected.body" "$WORK/actual.body"; then same=$((same + 1)); else different=$((different + 1)); echo "differs: $(basename "$file")"; fi
done
echo "identical: $same, different: $different"
