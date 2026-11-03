#!/usr/bin/env bash
# Writes the current git commit (first 8 characters) into Ring0/src/ring0/Version.ems, so that
# `ring0 --version` reports 0.1.0-indev.<commit>. Run it before building. Prints the version.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo unstamped)"
python3 - "$ROOT/Ring0/src/ring0/Version.ems" "$COMMIT" <<'PY'
import re, sys
path, commit = sys.argv[1], sys.argv[2]
text = open(path).read()
text = re.sub(r'(private static String commit\(\) \{\s*return ")[^"]*(";)', r'\g<1>' + commit + r'\g<2>', text)
open(path, 'w').write(text)
PY
echo "0.1.0-indev.$COMMIT"
