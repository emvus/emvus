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
sandbox, one at a time; code follows Pureline 1.3; comments, docs and diagnostics are English.

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
- [ ] `println`/`print`/`Process.args()` on the runtime IR
- [ ] Byte-wise text operations (`charAt`, `substring`, `indexOf`) once byte versus character is decided
- [ ] Literal top-level constants
- [ ] Nullable and Option lowering (Int, Bool, Float payloads first)

### Language decisions

- [ ] `String` operations count UTF-8 bytes or characters
- [ ] `main` exit code contract (the entry prints `main`'s Int today)
- [ ] Which Emvus subset is the stable input of Ring1

### Runtime IR (ours) and platform layer (Sublang)

- [ ] Sublang: platform operations (write, read file, write file, arguments, exit) with ownership modes, error codes and `observable` effect
- [ ] Sublang: a way to link a runtime module into a program
- [ ] Runtime IR: `rt.print`, `rt.println`, `rt.readFile`, `rt.writeFile`, `rt.argCount`, `rt.arg`, `rt.exit`
- [ ] Runtime IR: `rt.intToText`, text helpers, `rt.floatToText`
- [ ] Runtime IR: Map and Option layouts (after reference fields exist)

### Backend gates for idiomatic Emvus (see `selfhostRequirements.md`)

- [ ] G3 reference fields in records, lists and tuples
- [ ] G4 shared references
- [ ] G5 Option
- [ ] G6 Map
- [ ] G7 static fields
- [ ] Sublang `emit-llvm` crash on `tests/lowering/backendCrash.ev` (reported, not ours)

### Self-hosting

- [ ] Ring1 lexer in Emvus; token stream equals the Ring0 lexer on every fixture
- [ ] Ring1 parser; AST dump equals Ring0's on every fixture
- [ ] Ring1 binder and null flow; diagnostics equal Ring0's
- [ ] Ring1 lowering and wire output; wire equals Ring0's for the lowering fixtures
- [ ] First self-host: the Ring0-built compiler compiles its own source
- [ ] Fixed point: the result compiles itself to an identical executable
- [ ] Ring2 idiomatic rewrite on the available backend gates

### Housekeeping

- [ ] Pureline leftovers: `ExpressionChecker` (263 lines), `LoweringContext` (231), `InstanceDiscovery` (225), methods of 31 to 49 lines
- [ ] vscode-emvus aligned with the Ring0 syntax
