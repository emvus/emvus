# Emvus

Emvus is a statically typed language with `Result`-based error handling, data classes, cascades and
AST macros. This repository holds its compiler, in stages:

| Stage | What | Written in |
|---|---|---|
| `Ring0/` | the bootstrap compiler: parse, bind, lower to Sublang | Emerald |
| `Ring1/` | the first self-hosted compiler: lexer, parser, binder and a lowering for `Int`, `Bool`, `List` and `String`; it compiles itself (`Ring1/scripts/buildEmvuscRing1.sh`) | Emvus |
| `vscode-emvus/` | VS Code extension: highlighting, completion, diagnostics | TypeScript |

Native code comes from [Sublang](https://github.com/emvus/sub-lang) (LLVM) and a C compiler.
`PURELINE_SPECIFICATION_1.5.md` is the code style the sources follow.

## The compiler binary: `emvusc`

There are two Emvus compilers, and both are called `emvusc`: the one in `Ring0/` is written in Emerald, the one in
`Ring1/` in Emvus itself (`Ring1/README.md`).

```bash
scripts/buildEmvusc.sh <emerald-kit> <sub-lang-checkout>        # builds dist/emvusc-<version>/emvusc
dist/emvusc-*/emvusc helpers.ev main.ev -o demo.ll              # several files form one program
clang demo.ll -o demo && ./demo
dist/emvusc-*/emvusc --emit-wire main.ev -o main.sublang-wire   # the Sublang wire file instead
scripts/checkEmvusc.sh dist/emvusc-*/emvusc                     # smoke test
scripts/installEmvusc.sh dist/emvusc-*                          # installs to ~/.local/bin/emvusc (or give a prefix)
```

`emvusc` is one native binary (it needs only libc): parser, checker, lowering and the Sublang backend are
linked in, and it writes LLVM text. Turning that text into a program is `clang`'s step, because neither Emerald
nor Emvus can start a process. Building it needs the Emerald kit, a sub-lang checkout and python3. The build uses a
copy of the kit whose runtime keeps released memory alive, the workaround for a use-after-free in the
Emerald-built Sublang backend (see `scripts/buildEmvusc.sh`). Versions are
`0.1.0-indev.<first 8 characters of the commit>`, written by `scripts/stampVersion.sh`.

What the compiled programs can do today: integers, floats, booleans, text (`+`, `length`, `byteAt`,
`substring`, `indexOf`), lists, records, data classes, enums, classes with inheritance and interfaces,
generics, lambdas, `Result` with `switch`, top-level constants. The program prints the `Int` its `main`
returns (or exits with it, see below). Not yet: dictionaries, tasks, `null` on references (they need
Sublang runtime support, see `Ring0/docs/plan.md`). Programs can print (`print`, `println`), read and write files
(`readFile`, `writeFile`) and take arguments (`argument`) as Strings; such a program exits with the Int its `main` returns.

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), versions follow
[Semantic Versioning](https://semver.org/); see `CONTRIBUTING.md`.

## Tests

- `Ring0/scripts/checkLoweringNative.sh <emvusc> <work-dir>`: all 68 lowering fixtures to native programs and back to their
  expected output.
- `Ring1/scripts/runTests.sh`, `runCorpus.sh`, `runBinderCorpus.sh`: Ring1 against Ring0 as the oracle, all as native
  programs built with `emvusc`.
- `Ring1/scripts/buildEmvuscRing1.sh`: the Emvus compiler in Emvus compiles itself until the output stops changing.

## State and plan

`Ring0/docs/plan.md` has the checklist, `Ring0/docs/languageDecisions.md` the language decisions and
`Ring1/README.md` the state of the self-hosted compiler.
