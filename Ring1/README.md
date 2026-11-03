# Ring1

The first self-hosted stage of the Emvus compiler, written in Emvus and built by Ring0
(`Ring0/docs/plan.md`). Ring1 uses the **parameter-passing subset** decided in
`Ring0/docs/languageDecisions.md` (decision 3): primitive types, strings, enums, primitive records,
`Result`, and state kept in `List<Int>` parameters instead of objects with list fields.

## Lexer v0 (`src/lexer/`)

One file per responsibility, eight production files (the Emvus limit per folder, `PL-EV-017`); the
test file lives in `tests/` and does not count.

| File | Responsibility |
|---|---|
| `tokenKinds.ev` | token kinds, the five-Int token layout, `emit` |
| `cursor.ev` | the cursor list, `peek`, `advance`, `columnAt` |
| `byteClasses.ev` | byte constants and character classes |
| `identifiers.ev` | keywords and `lexIdentifier` |
| `trivia.ev` | whitespace and comments |
| `literals.ev` | numbers and strings (escapes, interpolation) |
| `symbols.ev` | one-, two- and three-byte symbols |
| `lexer.ev` | `scanToken`, `tokenize`, `lexSource` |

Ring0 builds several files as one program: `ring0 a.ev b.ev ... --check`, in the order given
(declarations before their use are not required). Order for the lexer:
`tokenKinds cursor byteClasses identifiers trivia literals symbols lexer` and, for the self test,
`tests/lexerTest.ev`.

- Tokens are five Ints in one list: `kind, start, length, line, column`. A token is a span of the
  source; `start` and `length` are UTF-8 byte offsets and columns count bytes.
- The cursor is a list of three Ints: position, line, start of the current line.
- Lexical errors are tokens of their own kind (`TOKEN_UNEXPECTED`, `TOKEN_UNTERMINATED_STRING`,
  `TOKEN_UNTERMINATED_COMMENT`); Ring0 reports them as diagnostics.
- A string token spans the raw text including the quotes; unescaping is not done by the lexer.
- For valid ASCII input the kinds, spans, lines and columns correspond to Ring0's lexer
  (`Ring0/src/ring0/syntax/lexing`): same keyword list, same two-byte and three-byte symbols,
  same fraction and exponent rules, same interpolation skipping.
- Identifier characters are ASCII letters, digits and `_`. Ring0 accepts any letter its host
  language knows; non-ASCII bytes outside strings and comments are `TOKEN_UNEXPECTED` here.
- `main` is a self test and returns the number of failed cases (0 = all passed).

## Parser (`src/parser/`)

Files by responsibility: `nodeTable` (the tree as a table of ten Ints per node), `tokenReader`, `treeDump`,
`parser` (entry points `parseSource` and `dumpSource`), and the folders `expressions/` (operators, postfix
forms, operands, lambdas, interpolation, generic calls, quotes), `statements/` (statements, locals,
destructuring), `switches/` (both switch forms) and `declarations/` (methods, parameters, modifiers,
types, imports, macros, class members). No file is longer than about 185 lines.

It covers the constructs of Ring0's tree except the ones listed under Open: package, `use` imports (single
items and groups), annotations, macros, `quote` and `$(...)` splices, `final var`, methods with generics, `where` bounds and `{ ... }` bodies, enums, records, data classes, exceptions, interfaces, classes with fields,
properties, constructors, `based` and `implements`, all statements (`if`, `while`, `for`, `foreach`, `switch`,
`fail`, `success`, locals, destructuring, `scoped`), and all expressions (operators, calls, indexing, ternary,
`?`, `!`, `is`, `as`, lambdas, cascades, list and dictionary literals, generic calls like `Tuple<Int>(1)`,
tasks, string interpolation) and optional semicolons.

- The tree has the shape of Ring0's AST (`Ring0/ast.md`); `dumpSource` prints it like Ring0's `dump`,
  including resolved string escapes.
- **Corpus:** `scripts/runCorpus.sh` runs the native `tests/astTool.ev` on every Ring0 test source (lowering,
  syntax, binding, flow, types, showcase) and every Ring1 source file and compares its tree with Ring0's.
  163 files, all identical to Ring0's tree: the whole language draft (`showcase.ev`), the Ring0 test sources
  and every Ring1 file, so the parser parses its own source tree.
- `tests/parserTest.ev` holds five hand-picked cases, expected trees generated from Ring0.

## Binder (`src/binder/`)

Gives the nodes of a parsed program their types and symbols, in tables of Ints: a type table (equal types
share a row, so comparing types is comparing Ints), a symbol table (methods and constants first, then the
locals and parameters of the method being bound, with a top marker as scope) and one annotation row per
node. Names are spans of the source and are compared without regard to case. `typesSource` prints the
annotations in the format of Ring0's `--check --types`.

v0 covers the constructs Ring1 is written in: Int, Float, Boolean, String, `List<T>` and named types,
locals and parameters, constants, calls of the program's methods (by name and argument count), the members
of String and List that the compiler uses, operators, indexing, list literals (an empty list takes the
expected type) and the statements `if`, `while`, `for`, `return` and expression statements.

- **Result:** the annotations of Ring1's whole source (lexer, parser, binder: 8,973 lines) are identical to
  Ring0's. `scripts/runBinderCorpus.sh` (with file arguments it shows the differences of that program) measures
  against Ring0's test sources: 77 of 78 are identical (the showcase uses built-ins outside the Ring1 subset:
  `Files`, `Int.parse`, `copy`, the members of `Any`; remaining differences also include interface calls,
  exception members, switch results, Dictionary/Tuple typing and task/async types).
- `diagnosticsSource` reports null dereferences, unsafe operands and null returns with line and column.
  Local assignments, null guards, early returns, short-circuit and ternary expressions are tracked;
  `tests/nullFlowTest.ev` contains eleven regression cases. Constructor initialization and full switch-flow
  analysis remain open; this is not yet diagnostic parity with Ring0.

## Running the tests

All scripts build native programs with `emvusc` (Ring0, the Emerald-built binary from `scripts/buildEmvusc.sh`)
and clang; the tests read files and print through the platform functions of Sublang's byte-text extension
(`readFile`, `argument`, `print`). No translation to Emerald is involved.

```bash
bash scripts/runTests.sh <emvusc> <work-dir>                       # lexer, parser, null flow, bootstrap: failed cases
bash scripts/runCorpus.sh <emvusc> <ring0-binary> <work-dir>       # parser against Ring0's trees
bash scripts/runBinderCorpus.sh <emvusc> <ring0-binary> <work-dir> # binder against Ring0's annotations
```

`<ring0-binary>` is Ring0's own command line tool (`Ring0/src/Main.ems`, built by the Emerald compiler), the oracle.
The bootstrap test runs Ring1's frontend and lowering natively on a small program and compares the type
annotations with Ring0's and the lowered text with what an earlier build produced. Full diagnostic and IR
parity with Ring0 remains open.

## The Emvus compiler in Emvus: `emvusc`

`src/emvusc/emvusc.ev` is the command line tool: `emvusc <file.ev>... [-o out.sublang-text]`. It lowers the Ring1
subset to Sublang canonical text; `sublang text-build`, `sublang emit-llvm` and clang turn that into a program.

```bash
bash scripts/buildEmvuscRing1.sh <ring0-emvusc> <sublang> <work-dir>
```

builds it in three stages: the Emerald-built `emvusc` compiles Ring1 (stage 1), stage 1 compiles Ring1 (stage 2),
stage 2 compiles Ring1 again (stage 3). The script succeeds when stages 2 and 3 produce the same text, a fixed point,
and leaves `<work-dir>/emvusc`. `bash scripts/runLoweringCorpus.sh <emvusc> <sublang> <work-dir>` runs Ring0's lowering
fixtures through it.

The platform functions (`print`, `println`, `errprint`, `errprintln`, `readFile`, `writeFile`, `fileExists`, `argument`,
`argumentCount`, `exit`) lower to calls of Sublang's platform imports; the lowering declares the imports a program calls
as functions without a body after its own functions.

Ring1 compiles only what it is written in (`Int`, `Bool`, `String`, `List<Int>`, `List<Bool>`, functions, control
flow), not yet floats, classes, records, `Result`, lambdas or generics; the tool answers with the line of the first
construct it cannot lower. It does not report syntax errors the way Ring0 does.

## State

| Check | Result |
|---|---|
| `ring0 <lexer files> tests/lexerTest.ev --check` | ok |
| Lowering to Sublang IR (`--dump`) | verifier: structure valid, semantics valid |
| Parser, lexer and tests together | check ok; lowers to 201 functions, verifier: structure and semantics valid |
| Native tests (Ring0 `emvusc` -> clang) | lexer, parser, null flow and bootstrap: 0 failed cases each, `scripts/runTests.sh` |
| Parser corpus | 163 of 163 identical to Ring0's trees, `scripts/runCorpus.sh` |
| Emvus `emvusc` bootstrap | stage 2 and stage 3 produce the same text, `scripts/buildEmvuscRing1.sh` |
| Wire export (formerly blocked by Sublang's 32-function limit) | works; the limits are raised in `sub-lang/src/sublang/limits/SublangLimits.ems` |

The function budget is a documented Sublang requirement (`Ring0/docs/lowering.md`, open backend
requirement 10), not a reason to merge small functions: a compiler written in Emvus has hundreds.
Sublang's own limits are 32 functions, 64 blocks per function, 4096 values per function and 32768
spans per module.

## Lowering (`src/lowering/`)

`lowerSource(source, name)` turns a program into Sublang canonical text (`docs/Sublang_Text_IR.md` in
sub-lang); `sublang text-build` verifies it and writes the wire file, which `sublang emit-llvm` and clang
turn into an executable. The lowered program is a flat list of records (functions, values, blocks,
operations) printed at the end, so blocks can be created in any order. Variables in scope are carried through
blocks as block parameters, the way Ring0 does it.

Supported: functions of `Int`/`Bool`/`Void`, `List<Int>`/`List<Bool>` (literals, `add`, `set`, `get`, `xs[i]`, `size`, `isEmpty`,
`for-in`, lent to callees for reading or writing, returned owned), constants, arithmetic, comparisons, `!`, `-`, `&&`/`||`,
calls, locals, assignment (also `+=` etc.), `++`/`--`, `if`, `while`, `for`, `break`, `continue`, `return`,
and the wrapping of a `Void` main. Everything else makes the lowering answer `unsupported <line>`.

`scripts/runLoweringCorpus.sh` runs Ring0's lowering fixtures through Ring1 and compares the native
output with the expected one: 12 pass, 0 fail, 33 are unsupported (floats, classes, `Result`, ...).

## Open

- Binder: diagnostics, null flow, the built-ins the showcase uses.
- Lowering: floats, records, classes, `Result`, lambdas, generics, the rest of the language.
- Not parsed yet: statement-level cascade items, and error recovery that matches Ring0's diagnostics (Ring1
  only produces error nodes). Ring0's trees for sources with syntax errors are not compared.
- Token stream comparison with Ring0 on every syntax fixture: needs a shared dump format; Ring0's `--tokens`
  prints `line:column kind text`.
- Parser, binder, null flow, lowering (see `Ring0/docs/plan.md`, Self-hosting).
