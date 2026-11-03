#!/usr/bin/env bash
# Installs a built emvusc binary: <prefix>/bin/emvusc.
# Usage: scripts/installEmvusc.sh <emvusc-binary-or-package-dir> [prefix]   (prefix defaults to ~/.local)
set -euo pipefail
SOURCE="$1"
[[ -d "$SOURCE" ]] && SOURCE="$SOURCE/emvusc"
[[ -f "$SOURCE" ]] || { echo "no emvusc binary at $SOURCE: build it with scripts/buildEmvusc.sh first"; exit 1; }
PREFIX="${2:-$HOME/.local}"
mkdir -p "$PREFIX/bin"
install -m 755 "$SOURCE" "$PREFIX/bin/emvusc"
echo "installed $("$PREFIX/bin/emvusc" --version | head -1) to $PREFIX/bin/emvusc"
