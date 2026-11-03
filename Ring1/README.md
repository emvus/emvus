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
- **Corpus:** `scripts/runCorpus.sh` generates one test case per Ring0 test source (lowering, syntax,
  binding, flow, types, showcase) and per Ring1 source file, and compares Ring1's tree with Ring0's.
  131 cases, all identical to Ring0's tree: the whole language draft (`showcase.ev`), the Ring0 test sources
  and every Ring1 file, so the parser parses its own source tree.
  `scripts/diffParse.sh` shows where one file differs.
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
  Ring0's. `scripts/diffTypes.sh` shows where a program differs; `scripts/runBinderCorpus.sh` measures
  against Ring0's test sources: 23 are identical, 55 differ because they use classes, `Result`, `switch`,
  enums, generics, lambdas or interpolation, which the binder does not know yet.
- No diagnostics yet: the binder assumes a valid program.

## Running the tests

The Sublang backend does not run yet, so the tests execute on Emerald: Ring0 parses the sources
(`ring0 files... --ast`), `scripts/emvusToEmerald.nv` translates the Ring1 subset to an Emerald class, the
Emerald compiler builds it and the program prints the number of failed cases.

```bash
EMERALD_HOME=<kit> bash scripts/runTests.sh <ring0-binary> <emerald-compiler> <novusc> <work-dir>
```

The translator `scripts/emvusToEmerald.nv` is written in Novus (https://github.com/ezTxmMC/novus, `novusc` from its
releases; it needs a C compiler to build). It is a test harness for exactly the constructs Ring1 uses, not a second compiler; it stops with an
error on anything else. It replaces constants by their values (like Ring0's lowering) and emulates `byteAt` for ASCII.

## State

| Check | Result |
|---|---|
| `ring0 <lexer files> tests/lexerTest.ev --check` | ok |
| Lowering to Sublang IR (`--dump`) | verifier: structure valid, semantics valid |
| Parser, lexer and tests together | check ok; lowers to 201 functions, verifier: structure and semantics valid |
| Wire export | **blocked** (Sublang builds again, the limit remains): Sublang allows at most 32 functions per module (`SUBLANG-W001 count budget exceeded`), the lexer and its test lower to 45 functions including 4 generated text helpers |
| Self tests on Emerald (translated) | lexer 17 of 17, parser 5 of 5, corpus 131 of 131 cases pass; a deliberately wrong expectation fails as it should |
| Native run of the self tests through Sublang | not done (needs the wire export and a working Sublang backend) |

The function budget is a documented Sublang requirement (`Ring0/docs/lowering.md`, open backend
requirement 10), not a reason to merge small functions: a compiler written in Emvus has hundreds.
Sublang's own limits are 32 functions, 64 blocks per function, 4096 values per function and 32768
spans per module.

## Open

- Binder: everything outside the Ring1 subset (see above), diagnostics, null flow.
- Not parsed yet: statement-level cascade items, and error recovery that matches Ring0's diagnostics (Ring1
  only produces error nodes). Ring0's trees for sources with syntax errors are not compared.
- Wire export and native run, after Sublang raises the module budget and builds again.
- Token stream comparison with Ring0 on every syntax fixture: needs file input (`G1`) and a shared
  dump format; Ring0's `--tokens` prints `line:column kind text`.
- Parser, binder, null flow, lowering (see `Ring0/docs/plan.md`, Self-hosting).
