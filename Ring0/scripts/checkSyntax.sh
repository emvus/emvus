#!/usr/bin/env bash
# Checks all tests/syntax/*.ev in ONE sandbox round (6 GB, no network, no swap):
#   n*.ev  negative tests: lines "// expect: <fragment>@<line>" must appear as a diagnostic,
#          exit code must be 1 (no hang or crash).
#   p*.ev  positive tests ("// expect-ok"): exit 0, no diagnostics.
#   showcase.ev: exit 0; the AST is compared with tests/golden/showcase.ast (if present).
set -euo pipefail
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
    "$IMAGE" timeout --signal=TERM --kill-after=5s 420s bash -c '
      timeout 180s /emerald/emerald-stable/emerald-compiler build /project/src/Main.ems -o /tmp/ring0 >/tmp/build.log 2>&1 || { cat /tmp/build.log; exit 2; }
      fail=0; total=0
      for f in /project/tests/syntax/*.ev; do
        total=$((total+1)); name=$(basename "$f")
        timeout 10s /tmp/ring0 "$f" >/tmp/out.txt 2>&1; code=$?
        if grep -q "^// expect-ok" "$f"; then
          if [ $code -ne 0 ]; then echo "FAIL $name: exit $code (expected 0)"; grep "^error" /tmp/out.txt | head -3; fail=$((fail+1)); else echo "ok   $name"; fi
          continue
        fi
        if [ $code -ne 1 ]; then echo "FAIL $name: exit $code (expected 1)"; fail=$((fail+1)); continue; fi
        bad=0
        while IFS= read -r exp; do
          frag="${exp#// expect: }"; frag="${frag%@*}"; line="${exp##*@}"
          if ! grep "^error ${line}:" /tmp/out.txt | grep -qF -- "$frag"; then
            echo "FAIL $name: missing \"$frag\" at line $line"; bad=1
          fi
        done < <(grep "^// expect: " "$f")
        if [ $bad -eq 1 ]; then grep "^error" /tmp/out.txt | head -5 | sed "s/^/       got: /"; fail=$((fail+1)); else echo "ok   $name"; fi
      done
      timeout 10s /tmp/ring0 /project/tests/showcase.ev >/tmp/showcase.out 2>&1; code=$?
      total=$((total+1))
      if [ $code -ne 0 ]; then echo "FAIL showcase.ev: exit $code"; fail=$((fail+1)); else echo "ok   showcase.ev"; fi
      if [ -f /project/tests/golden/showcase.ast ]; then
        if diff -q /project/tests/golden/showcase.ast /tmp/showcase.out >/dev/null; then echo "ok   showcase AST unchanged"; else echo "FAIL showcase AST differs"; diff /project/tests/golden/showcase.ast /tmp/showcase.out | head -40; fail=$((fail+1)); fi
      else
        diff /project/tests/golden/showcase.ast.base /tmp/showcase.out | head -60 || true
      fi
      echo "$((total-fail))/$total passed"
      [ $fail -eq 0 ]
    '
