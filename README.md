# Emvus

Emvus is a statically typed language with `Result`-based error handling, data classes, cascades and
AST macros. This repository holds its compiler, in stages:

| Stage | What | Written in |
|---|---|---|
| `Ring0/` | the bootstrap compiler: parse, bind, lower to Sublang | Emerald |
| `Ring1/` | the first self-hosted compiler: lexer, parser, binder and a lowering for `Int`, `Bool`, `List` and `String`; it compiles itself (`Ring1/scripts/runBootstrap.sh`) | Emvus |
| `vscode-emvus/` | VS Code extension: highlighting, completion, diagnostics | TypeScript |

Native code comes from [Sublang](https://github.com/emvus/sub-lang) (LLVM) and a C compiler.
`PURELINE_SPECIFICATION_1.5.md` is the code style the sources follow.

## The compiler binary: `emvusc`

```bash
NOVUSC=<path to novusc> scripts/buildEmvusc.sh <emerald-kit> <sub-lang-checkout>   # builds dist/emvusc-<version>/
dist/emvusc-*/emvusc helpers.ev main.ev -o demo && ./demo      # several files form one program
dist/emvusc-*/emvusc --run main.ev
dist/emvusc-*/emvusc --emit-llvm main.ev                       # or --emit-wire
scripts/checkEmvusc.sh dist/emvusc-*/emvusc                    # smoke test of the package
scripts/installEmvusc.sh dist/emvusc-*                         # installs to ~/.local/bin/emvusc (or give a prefix)
```

The package holds three native binaries: `emvusc` (the driver, written in [Novus](https://github.com/ezTxmMC/novus)),
`ring0-lower` and `sublang` (both written in Emerald). They need only libc; at run time the driver calls `clang`
(or `EMVUSC_CC`). Building the package needs the Emerald kit, a sub-lang checkout, `novusc` and a C compiler. Versions are `0.1.0-indev.<first 8 characters of the commit>`,
written by `scripts/stampVersion.sh`.

What the compiled programs can do today: integers, floats, booleans, text (`+`, `length`, `byteAt`,
`substring`, `indexOf`), lists, records, data classes, enums, classes with inheritance and interfaces,
generics, lambdas, `Result` with `switch`, top-level constants. The program prints the `Int` its `main`
returns. Not yet: `println`, files, arguments, dictionaries, tasks, `null` on references (they need
Sublang runtime support, see `Ring0/docs/plan.md`). `emvusc` stays the compiler you use: its frontend is
Ring0 until Sublang can read files and take arguments, which a compiler written in Emvus needs.

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), versions follow
[Semantic Versioning](https://semver.org/); see `CONTRIBUTING.md`.

## Tests

- `Ring0/scripts/checkLoweringNative.sh`: all 67 lowering fixtures to native programs and back to their
  expected output.
- `Ring1/scripts/runTests.sh`, `runCorpus.sh`, `runBinderCorpus.sh`: Ring1 against Ring0 as the oracle.
- The same Ring1 tests also run natively through `emvusc`; see `Ring1/README.md`.

## State and plan

`Ring0/docs/plan.md` has the checklist, `Ring0/docs/languageDecisions.md` the language decisions and
`Ring1/README.md` the state of the self-hosted compiler.
