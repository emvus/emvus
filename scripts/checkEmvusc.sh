#!/usr/bin/env bash
# Smoke test of an emvusc package: compiles small programs and compares what they print with what is expected.
# Usage: scripts/checkEmvusc.sh <emvusc-binary>
set -euo pipefail
EMVUSC="$(realpath "$1")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
status=0
check() {
    local name="$1" expected="$2" source="$3"
    printf '%s\n' "$source" > "$WORK/$name.ev"
    if "$EMVUSC" "$WORK/$name.ev" -o "$WORK/$name" > "$WORK/$name.log" 2>&1 && [[ "$("$WORK/$name")" == "$expected" ]]; then
        echo "ok   $name"
    else
        echo "FAIL $name: $(head -1 "$WORK/$name.log")"
        status=1
    fi
}
check arithmetic 42 $'static method<Int> main {\n    return 6 * 7\n}'
check loop 45 $'static method<Int> main {\n    Int total = 0\n    for (Int i = 0; i < 10; i++) {\n        total += i\n    }\n    return total\n}'
check classes 7 $'class Counter {\n    Int count { get, set }\n\n    Counter(Int start) {\n        this.count = start\n    }\n\n    method increment {\n        count = count + 1\n    }\n}\n\nstatic method<Int> main {\n    Counter c = Counter(6)\n    c.increment()\n    return c.count\n}'
check text 5 $'static method<Int> main {\n    String s = "ab" + "cde"\n    return s.length()\n}'
exit $status
