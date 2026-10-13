#!/usr/bin/env bash
# Builds Ring0 once in the sandbox and checks:
#  - tests/showcase.ev passes --check
#  - every tests/binding/*.ev and tests/flow/*.ev (line 1: `// expect: <text>`) fails with that diagnostic
#  - every tests/types/*.ev prints the annotation listing of `--check --types` equal to tests/types/golden/<name>.types
#    (create a golden by running: scripts/runSandbox.sh tests/types/<name>.ev --check --types)
set -uo pipefail
# One compiler or program run at a time: all sandbox scripts share this lock.
exec 9>"${TMPDIR:-/tmp}/ring0-sandbox.lock"
flock 9
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMERALD_ROOT="${RING0_EMERALD_ROOT:-/run/media/syntaxjason/0A625B37625B272B/Code Space/Emerald/Emerald LLVM}"
IMAGE="${RING0_SANDBOX_IMAGE:-emerald-selfhost-sandbox}"
docker run --rm --init --network=none --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges --memory=6000000000 --memory-swap=6000000000 \
    --cpus=2 --pids-limit=128 --ulimit core=0 --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$ROOT,dst=/project,readonly" \
    --mount "type=bind,src=$EMERALD_ROOT,dst=/emerald,readonly" \
    --tmpfs /tmp:rw,exec,nosuid,size=1073741824 \
    -e HOME=/tmp -e EMERALD_HOME=/emerald \
    -e EMERALD_LLVM_LIB_DIR=/usr/lib -e EMERALD_LLVM_LIBRARY=LLVM \
    "$IMAGE" timeout --signal=TERM --kill-after=5s 400s sh -c '
      timeout 180s /emerald/emerald-stable/emerald-compiler build /project/src/Main.ems -o /tmp/ring0 >/dev/null || { echo "BUILD FAILED"; exit 2; }
      fail=0
      out=$(timeout 30s /tmp/ring0 /project/tests/showcase.ev --check 2>&1)
      if [ "$out" = "check ok" ]; then echo "PASS showcase.ev"; else echo "FAIL showcase.ev"; echo "$out" | head -10; fail=1; fi
      for f in /project/tests/binding/*.ev /project/tests/flow/*.ev; do
        expect=$(head -1 "$f" | sed "s#^// expect: ##")
        out=$(timeout 30s /tmp/ring0 "$f" --check 2>&1)
        if echo "$out" | grep -qF -- "$expect"; then echo "PASS $(basename "$f")"; else echo "FAIL $(basename "$f") (expected: $expect)"; echo "$out" | head -5; fail=1; fi
      done
      for f in /project/tests/types/*.ev; do
        name=$(basename "$f" .ev)
        out=$(timeout 30s /tmp/ring0 "$f" --check --types 2>&1)
        golden=/project/tests/types/golden/$name.types
        if [ "$out" = "$(cat "$golden" 2>/dev/null)" ]; then echo "PASS $name.ev (types)"; else echo "FAIL $name.ev (types)"; echo "$out" | head -8; fail=1; fi
      done
      exit $fail'
