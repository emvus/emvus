#!/usr/bin/env bash
# Compares the syntax errors Ring1's parser reports with Ring0's. The error fixtures of Ring0 (tests/syntax/n*.ev) must
# match exactly. Mutants (one token of a test source deleted or replaced, seeded so the run repeats) measure how closely
# the recovery after an error follows Ring0's; their match rate is reported, not enforced.
# Usage: scripts/runSyntaxCorpus.sh <emvusc> <ring0-binary> <work-dir> [mutants] [seed]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMVUSC="$(realpath "$1")"
RING0="$(realpath "$2")"
WORK="$(realpath -m "$3")"
MUTANTS="${4:-200}"
SEED="${5:-1}"
TESTS="$ROOT/../Ring0/tests"
cd "$ROOT"
source scripts/common.sh
mkdir -p "$WORK"
build "$EMVUSC" "$WORK/syntaxTool" "${LEXER[@]}" "${PARSER[@]}" tests/syntaxTool.ev
failed=0
for file in "$TESTS"/syntax/n*.ev; do
    if ! diff <("$RING0" "$file" 2>&1 | grep '^error') <("$WORK/syntaxTool" "$file") > /dev/null; then echo "differs: $(basename "$file")"; failed=$((failed + 1)); fi
done
echo "error fixtures: $(ls "$TESTS"/syntax/n*.ev | wc -l) compared, $failed differ"
python3 - "$RING0" "$WORK/syntaxTool" "$MUTANTS" "$SEED" "$TESTS" "$WORK" <<'PY'
import glob, random, re, subprocess, sys
ring0, tool, count, seed, tests, work = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
random.seed(seed)
files = sorted(glob.glob(tests + "/lowering/*.ev") + glob.glob(tests + "/types/*.ev"))
token = re.compile(r'[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|"[^"\n]*"|->|\.\.|[{}()\[\];,.:?!<>=+\-*/%&|@$]')
same = different = 0
for _ in range(count):
    text = open(random.choice(files)).read()
    found = list(token.finditer(text))
    pick = random.choice(found)
    if random.random() < 0.67:
        mutant = text[:pick.start()] + text[pick.end():]
    else:
        mutant = text[:pick.start()] + random.choice(found).group(0) + text[pick.end():]
    path = work + "/mutant.ev"
    open(path, "w").write(mutant)
    expected = [l for l in subprocess.run([ring0, path], capture_output=True, text=True).stdout.split("\n") if l.startswith("error ")]
    actual = [l for l in subprocess.run([tool, path], capture_output=True, text=True).stdout.split("\n") if l.startswith("error ")]
    if expected == actual:
        same += 1
    else:
        different += 1
print("mutants: %d compared, %d identical, %d differ (%.0f%% identical)" % (count, same, different, 100.0 * same / count))
PY
[[ $failed -eq 0 ]]
