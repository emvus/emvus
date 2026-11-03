#!/usr/bin/env bash
# Shows where the Ring1 parser's tree differs from Ring0's for one source file.
# Needs a corpus run first (scripts/runCorpus.sh builds the dump program in <work-dir>/corpus).
# Usage: EMERALD_HOME=<kit> scripts/diffParse.sh <ring0-binary> <emerald-compiler> <work-dir> <file.ev>
set -euo pipefail
RING0="$1"
EMERALD="$2"
WORK="$3"
SOURCE="$4"
if [[ ! -x "$WORK/corpus/dump" ]]; then
    "$EMERALD" build "$WORK/corpus/Ring1Dump.ems" -o "$WORK/corpus/dump" > /dev/null
fi
diff <("$RING0" "$SOURCE") <("$WORK/corpus/dump" "$SOURCE") && echo "identical"
