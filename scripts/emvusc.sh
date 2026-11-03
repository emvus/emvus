#!/usr/bin/env bash
# emvusc: the Emvus compiler. Emvus source -> Ring0 (parse, bind, lower) -> Sublang wire -> Sublang (LLVM)
# -> clang -> native executable. The tools sit next to this script.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOWER="$HERE/ring0-lower"
SUBLANG="$HERE/sublang"
CC="${EMVUSC_CC:-${CC:-clang}}"
# The Emerald-built Sublang frees memory it still uses on larger programs (reported as "Emerald Flow
# allocation failed"). Keeping released allocations alive avoids it; the compiler is a short-lived process.
export EMERALD_FLOW_BOOTSTRAP=1

usage() {
    cat <<'TEXT'
usage: emvusc [options] <file.ev>...

  -o <path>       output (default: the stem of the first file)
  --emit-wire     stop after the Sublang wire file (<path>.sublang-wire)
  --emit-llvm     stop after the LLVM text (<path>.ll)
  --run           run the executable after building it
  -O<0|1|2|3>     optimization level of the C compiler (default -O2)
  --keep          keep the intermediate files next to the output
  --version       print the version
  -h, --help      print this text

Several files form one program, in the order given. The executable prints the Int that `main` returns;
`println` and file access are not available yet. Set EMVUSC_CC to use another C compiler.
TEXT
}

output=""
stop=""
run=0
keep=0
optimization="-O2"
files=()
while (($#)); do
    case "$1" in
        -o) output="${2:?missing path after -o}"; shift 2 ;;
        --emit-wire) stop="wire"; shift ;;
        --emit-llvm) stop="llvm"; shift ;;
        --run) run=1; shift ;;
        --keep) keep=1; shift ;;
        -O0|-O1|-O2|-O3) optimization="$1"; shift ;;
        --version) cat "$HERE/VERSION"; exit 0 ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "emvusc: unknown option $1" >&2; usage >&2; exit 2 ;;
        *) files+=("$1"); shift ;;
    esac
done
if ((${#files[@]} == 0)); then usage >&2; exit 2; fi
for file in "${files[@]}"; do
    [[ -f "$file" ]] || { echo "emvusc: no such file: $file" >&2; exit 2; }
done
if [[ -z "$output" ]]; then output="$(basename "${files[0]}" .ev)"; fi

work="$(mktemp -d)"
cleanup() { if ((keep == 0)); then rm -rf "$work"; fi; }
trap cleanup EXIT
wire="$work/program.sublang-wire"
llvm="$work/program.ll"

if ! "$LOWER" "${files[@]}" "$wire" > "$work/ring0.log" 2>&1 || [[ ! -f "$wire" ]]; then
    cat "$work/ring0.log" >&2
    exit 1
fi
if [[ "$stop" == "wire" ]]; then cp "$wire" "$output.sublang-wire"; exit 0; fi

if ! "$SUBLANG" emit-llvm "$wire" "$llvm" auto on > "$work/sublang.log" 2>&1; then
    echo "emvusc: Sublang rejected the program:" >&2
    cat "$work/sublang.log" >&2
    exit 1
fi
if [[ "$stop" == "llvm" ]]; then cp "$llvm" "$output.ll"; exit 0; fi

if ! "$CC" "$optimization" -w "$llvm" -o "$output" 2> "$work/cc.log"; then
    echo "emvusc: the C compiler failed:" >&2
    cat "$work/cc.log" >&2
    exit 1
fi
if ((keep)); then cp "$wire" "$output.sublang-wire"; cp "$llvm" "$output.ll"; cp "$llvm.plan" "$output.plan" 2>/dev/null || true; fi
if ((run)); then
    case "$output" in */*) exec "$output" ;; *) exec "./$output" ;; esac
fi
