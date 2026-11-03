#!/usr/bin/env bash
# Builds emvusc, the Emvus compiler written in Emerald (Ring0): one native binary that reads .ev files and writes
# LLVM text (or the Sublang wire file). The Sublang compiler is linked in from a sub-lang checkout. Building
# needs only the Emerald kit and sub-lang (and python3 for one patch of a copy of the kit); the result needs only libc. Turning the LLVM text into a program
# is clang's job: `clang prog.ll -o prog`.
# Usage: scripts/buildEmvusc.sh <emerald-kit-dir> <sub-lang-dir> [out-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$(cd "$1" && pwd)"
SUBLANG_DIR="$(cd "$2" && pwd)"
EMVUS_VERSION="$("$ROOT/scripts/stampVersion.sh")"
"$SUBLANG_DIR/scripts/stampVersion.sh" > /dev/null
OUT="${3:-$ROOT/dist/emvusc-$EMVUS_VERSION}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# The Sublang compiler built by Emerald can stop with "Emerald Flow allocation failed" on larger programs (a
# use-after-free whose cause is not found; EMERALD_FLOW_UAF_HUNT=1 reproduces it). Emerald's own workaround is the
# bootstrap mode that never reuses released memory. A binary cannot set an environment variable for itself, so the
# kit is copied and its runtime made to default to that mode; the Emerald installation itself stays untouched.
cp -r "$KIT" "$WORK/kit"
python3 - "$WORK/kit/runtime/src/flow/state.c" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
old = 'cached = emerald_flow_env_flag("EMERALD_FLOW_BOOTSTRAP");'
if old not in text:
    sys.exit("the Emerald runtime no longer has the bootstrap flag this script patches")
open(path, "w").write(text.replace(old, "cached = 1;", 1))
PY
export EMERALD_HOME="$WORK/kit"

# Emerald resolves `use` only below the entry file's directory, so the sources are gathered in one tree.
cp -r "$ROOT/Ring0/src/ring0" "$WORK/ring0"
cp "$ROOT/Ring0/src/EmvuscMain.ems" "$WORK/"
cp -r "$SUBLANG_DIR/src/sublang" "$WORK/sublang"
"$WORK/kit/bin/emerald-compiler" build "$WORK/EmvuscMain.ems" -o "$OUT/emvusc" > /dev/null
chmod +x "$OUT/emvusc"
"$OUT/emvusc" --version > "$OUT/VERSION"
echo "built $OUT/emvusc"
cat "$OUT/VERSION"
