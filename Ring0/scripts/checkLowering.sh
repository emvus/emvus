#!/usr/bin/env bash
# Compiles every tests/lowering/*.ev end to end (lowering -> Sublang wire -> native) in one
# bundled run and compares the program output with tests/lowering/expected/<name>.out.
# A fixture whose first line is `// expect-error: <fragment>` must instead be rejected by the
# lowering with a diagnostic containing the fragment. `// expect-abort` means the native
# program must terminate with SIGABRT (exit 134): checked overflow, division by zero, panic.
# `// expect-backend-crash` marks a documented Sublang defect that is expected to reproduce.
# Environment overrides: see runLoweringSandbox.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
scripts/runLoweringSandbox.sh --run tests/lowering/*.ev > "$LOG" 2>&1 || true
# Text of one section: lines after "=== <name>" (or "=== <name>: native") up to the next "===".
section() {
    awk -v head="=== $1$2" '
        $0 == head { on = 1; next }
        /^=== / { on = 0 }
        on { print }' "$LOG"
}
status=0
for source in tests/lowering/*.ev; do
    name="$(basename "$source" .ev)"
    expectedError="$(sed -n '1s|^// expect-error: ||p' "$source")"
    if [[ "$(sed -n '1p' "$source")" = "// expect-backend-crash" ]]; then
        if section "$name" ": native" | grep -qF -- "allocation failed"; then
            echo "ok   $name (known Sublang emit-llvm abort, see docs/lowering.md)"
        else
            echo "NOTE $name: the known backend abort no longer reproduces; update docs/lowering.md"
            status=1
        fi
        continue
    fi
    if [[ "$(sed -n '1p' "$source")" = "// expect-abort" ]]; then
        if section "$name" ": native" | grep -qF -- "exit=134"; then
            echo "ok   $name (aborted as expected)"
        else
            echo "FAIL $name: expected the program to abort (exit=134)"
            status=1
        fi
        continue
    fi
    if [[ -n "$expectedError" ]]; then
        if section "$name" "" | grep -qF -- "$expectedError"; then
            echo "ok   $name (rejected as expected)"
        else
            echo "FAIL $name: expected diagnostic containing '$expectedError'"
            status=1
        fi
        continue
    fi
    actual="$(section "$name" ": native" | grep -v -e '^Built ' -e '^plan: ' || true)"
    if [[ "$actual" = "$(cat "tests/lowering/expected/$name.out")" ]]; then
        echo "ok   $name = $actual"
    else
        echo "FAIL $name: expected '$(cat "tests/lowering/expected/$name.out")', got '$actual'"
        status=1
    fi
done
exit $status
