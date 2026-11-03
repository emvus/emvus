#!/usr/bin/env bash
# Builds the emvusc package: ring0-lower (Ring0 with the Sublang IR builder, built by Emerald), sublang
# (the Sublang compiler, built by Emerald) and emvusc, the driver (written in Novus, built by novusc).
# All three binaries need only libc. Building needs the Emerald kit, a sub-lang checkout, novusc and a C compiler.
# Usage: scripts/buildEmvusc.sh <emerald-kit-dir> <sub-lang-dir> [out-dir]
# novusc is taken from $NOVUSC or the PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$(cd "$1" && pwd)"
SUBLANG_DIR="$(cd "$2" && pwd)"
export EMERALD_HOME="$KIT"
COMPILER="$KIT/bin/emerald-compiler"
EMVUS_VERSION="$("$ROOT/scripts/stampVersion.sh")"
SUBLANG_VERSION="$("$SUBLANG_DIR/scripts/stampVersion.sh")"
OUT="${3:-$ROOT/dist/emvusc-$EMVUS_VERSION}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# Emerald resolves `use` only below the entry file's directory, so the sources are gathered in one tree.
mkdir -p "$WORK/lower"
cp -r "$ROOT/Ring0/src/ring0" "$WORK/lower/ring0"
cp "$ROOT/Ring0/src/LoweringMain.ems" "$WORK/lower/"
cp -r "$SUBLANG_DIR/src/sublang" "$WORK/lower/sublang"
"$COMPILER" build "$WORK/lower/LoweringMain.ems" -o "$OUT/ring0-lower" > /dev/null
"$COMPILER" build "$SUBLANG_DIR/src/SublangMain.ems" -o "$OUT/sublang" > /dev/null
"${NOVUSC:-novusc}" build "$ROOT/emvusc/emvusc.nv" -o "$OUT/emvusc" > /dev/null
chmod +x "$OUT/emvusc" "$OUT/ring0-lower" "$OUT/sublang"
{
    echo "emvusc $EMVUS_VERSION"
    echo "sublang $SUBLANG_VERSION"
} > "$OUT/VERSION"
echo "built $OUT"
cat "$OUT/VERSION"
