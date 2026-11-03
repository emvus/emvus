# Emvus bootstrap plan and checklist

## Summary

Emvus is a new language with its own compiler. The compiler is bootstrapped in stages:

| Stage | What | Written in | Status |
|---|---|---|---|
| Ring0 | Bootstrap compiler: Emvus source to native executable through the Sublang backend | Emerald (`.ems`) | frontend and lowering work, frozen except for fixes that block self-hosting |
| Runtime IR | Runtime library (output, files, arguments, text and number helpers, later Map and Option) | Sublang IR, written by us; the platform layer (syscalls, Windows API) is provided by Sublang | not started, waits for the Sublang side |
| Ring1 | First self-hosted compiler, data-oriented subset (lexer first) | Emvus (`.ev`), built by Ring0 | not started |
| Ring2 | Idiomatic self-hosted compiler (`Node`, `List<Node>`, `Dictionary`) | Emvus, built by Ring1 or Ring0 | needs backend gates G3 to G6 |

Pipeline today:

```text
.ev -> Lexer -> Parser -> Binder (types, symbols, null flow) -> Lowering
    -> Sublang High IR (.sublang-wire v2) -> Sublang build (--flow=on --optimind=on) -> LLVM -> native
```

Principles: Emvus semantics are never weakened to fit the backend (a missing backend capability is
a diagnostic and a documented requirement); Int is Int64 with an explicit overflow mode per
operation; text is an owned `List<Byte>`; all compiler and program runs happen in the capped
sandbox, one at a time; code follows Pureline 1.5; comments, docs and diagnostics are English.

## Checklist

### Ring0 frontend

- [x] Lexer, parser, uniform AST (`ast.md`)
- [x] Binder: types, symbols, overloads by arity, generics, Result rules
- [x] Null flow
- [x] Diagnostics with line and column, fixture suites (`tests/syntax`, `binding`, `flow`, `types`)
- [x] Annotation fixes: tuple literals, function-value calls, class-named properties
- [ ] Overload resolution by argument types (only if self-hosted code needs it)
- [ ] Macro and `quote` expansion (not needed for Ring1)

### Ring0 lowering (Sublang backend)

- [x] Int, Bool, Float, dynamic text, control flow, functions and recursion
- [x] Records, data classes, enums, tuples
- [x] `Result<T,E>` with `?`, `!`, `orElse`, `switch`
- [x] Classes, inheritance, interfaces, `is`/`as`, `scoped var`, cascade
- [x] Lists, generics (monomorphized), lambdas, `map`/`filter`/`reduce`/`forEach`
- [x] 59 lowering fixtures green with Flow and Optimind on
- [x] all 67 lowering fixtures run natively through Sublang (Low IR route) and match their expected output, aborts and errors: `scripts/checkLoweringNative.sh`
- [ ] `println`/`print`/`Process.args()` on the runtime IR
- [x] Byte-wise `byteAt` and `substring` (bytes, decision 1); `charAt` is reserved
- [x] `indexOf` (generated search helper `emvus.text.indexOf`; lowered to wire, not yet run natively)
- [x] Literal top-level constants (Int, Bool, Float; inlined, see `lowering.md`; String constants and static fields still wait for G7 storage)
- [ ] Nullable reference lowering (String, classes, lists; needs G3). `Int`, `Bool` and `Float` cannot be null in the checker (`TypeRules.assignable`), so there is no primitive-payload step; an `Option<T>` library type is a separate language decision

### Language decisions

- [x] `String` operations count UTF-8 bytes (`languageDecisions.md`, decision 1: bytes now, `byteAt`, characters later)
- [x] `main` exit code contract decided (`languageDecisions.md`, decision 2): the Int is the exit status, `Void` is 0; the entry keeps printing as a named bootstrap behavior until Sublang offers output and exit (G1), then the switch is part of the G1 work
- [x] Ring1 subset v0 decided (`languageDecisions.md`, decision 3): parameter-passing style over primitive types, strings, enums, primitive records, `Result` and lists passed as parameters; no list-typed class fields; idiomatic Ring2 waits for G3 to G6

### Runtime IR (ours) and platform layer (Sublang)

- [ ] Sublang: platform operations (write, read file, write file, arguments, exit) with ownership modes, error codes and `observable` effect
- [ ] Sublang: a way to link a runtime module into a program
- [ ] Runtime IR: `rt.print`, `rt.println`, `rt.readFile`, `rt.writeFile`, `rt.argCount`, `rt.arg`, `rt.exit`
- [ ] Runtime IR: `rt.intToText`, text helpers, `rt.floatToText`
- [ ] Runtime IR: Map and Option layouts (after reference fields exist)

### Backend gates for idiomatic Emvus (see `selfhostRequirements.md`)

- [ ] G3 reference fields in records, lists and tuples
- [ ] G4 shared references
- [ ] G5 absence: nullable references (depends on G3)
- [ ] G6 Map
- [ ] G7 static fields
- [x] Sublang module budget raised (4096 functions, see `SublangLimits`); Sublang builds again since `src/sublang/low/target/` was reconstructed; Ring1 (330 functions with the corpus) runs natively
- [ ] Sublang `emit-llvm` crash on `tests/lowering/backendCrash.ev` (reported, not ours)

### Self-hosting

- [ ] Ring1 lexer in Emvus; token stream equals the Ring0 lexer on every fixture (v0 is `Ring1/src/lexer.ev`: checks and lowers, wire export blocked by Sublang's 32-function module budget, not run; see `Ring1/README.md`)
- [ ] Ring1 parser; AST dump equals Ring0's on every fixture (131 of 131 corpus cases identical, including the whole showcase and Ring1's own sources, run on Emerald; open: error recovery and diagnostics; not run through Sublang; see `Ring1/README.md`)
- [ ] Ring1 binder and null flow; diagnostics equal Ring0's (binder v0 annotates Ring1's own source identically to Ring0, 23 of 78 Ring0 test sources; no diagnostics, no null flow yet; see `Ring1/README.md`)
- [ ] Ring1 lowering and wire output; wire equals Ring0's for the lowering fixtures
- [ ] First self-host: the Ring0-built compiler compiles its own source
- [ ] Fixed point: the result compiles itself to an identical executable
- [ ] Ring2 idiomatic rewrite on the available backend gates

### Housekeeping

- [x] Pureline 1.5 review: no folder above 8 `.ems` files, no `else`, no brace-free control flow, no method above 50 lines (65 methods of 31 to 50 lines are in the review band), largest classes are the constant tables `AstKinds` (416) and `NodeKinds` (400); class size is guidance only (`PL-STRUCT-003`)
- [x] vscode-emvus aligned with Ring0 (syntax unchanged since it was derived; `String.byteAt` added to its builtins; its 49 tests pass against `Ring0/tests`)
