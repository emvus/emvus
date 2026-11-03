#!/usr/bin/env bash
# Installs a built emvusc package: the three binaries and VERSION go to <prefix>/lib/emvusc and a link to
# the driver to <prefix>/bin/emvusc. The driver finds ring0-lower and sublang next to itself, so the links are
# resolved to the real location.
# Usage: scripts/installEmvusc.sh <package-dir> [prefix]   (prefix defaults to ~/.local)
set -euo pipefail
PACKAGE="$(cd "$1" && pwd)"
PREFIX="${2:-$HOME/.local}"
for file in emvusc ring0-lower sublang VERSION; do
    [[ -f "$PACKAGE/$file" ]] || { echo "missing $PACKAGE/$file: build the package with scripts/buildEmvusc.sh first"; exit 1; }
done
mkdir -p "$PREFIX/lib/emvusc" "$PREFIX/bin"
cp "$PACKAGE/emvusc" "$PACKAGE/ring0-lower" "$PACKAGE/sublang" "$PACKAGE/VERSION" "$PREFIX/lib/emvusc/"
ln -sf "$PREFIX/lib/emvusc/emvusc" "$PREFIX/bin/emvusc"
echo "installed $("$PREFIX/bin/emvusc" --version | head -1) to $PREFIX/bin/emvusc"
