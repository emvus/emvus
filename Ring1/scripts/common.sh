# shellcheck shell=bash
# Shared by the Ring1 scripts (source it): the source file lists and a helper that builds an Emvus program into a native
# binary with the Emerald-built emvusc (Ring0) and clang.
LEXER=(src/lexer/tokenKinds.ev src/lexer/cursor.ev src/lexer/byteClasses.ev src/lexer/identifiers.ev src/lexer/trivia.ev src/lexer/literals.ev src/lexer/symbols.ev src/lexer/lexer.ev)
PARSER=(src/parser/*.ev src/parser/*/*.ev)
BINDER=(src/binder/*.ev src/binder/*/*.ev)
LOWERING=(src/lowering/*.ev src/lowering/*/*.ev)

# build <emvusc> <output-binary> <file.ev>...
build() {
    local emvusc="$1" output="$2"
    shift 2
    "$emvusc" "$@" -o "$output.ll" > /dev/null
    clang -O2 -w "$output.ll" -o "$output"
}

# join <output.ev> <file.ev>...: one program from several files, like Ring0's SourceSet (only the first file keeps its package line)
join() {
    local output="$1" first=1
    shift
    : > "$output"
    for file in "$@"; do
        if [[ $first -eq 1 ]]; then cat "$file" >> "$output"; first=0; else grep -v '^package ' "$file" >> "$output"; fi
    done
}
