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

Files by responsibility: `nodeTable` (the tree as a table of eight Ints per node), `tokenReader`, `treeDump`,
`parser` (entry points `parseSource` and `dumpSource`), and the folders `expressions/` (operators, calls,
cascades, lambdas), `statements/` (statements, locals, destructuring), `switches/` (both switch forms) and
`declarations/` (methods, types, class members).

It covers the constructs of Ring0's tree except the ones listed under Open: package, `use` imports (single
items and groups), annotations, `final var`, methods with generics, `where` bounds and `{ ... }` bodies, enums, records, data classes, exceptions, interfaces, classes with fields,
properties, constructors, `based` and `implements`, all statements (`if`, `while`, `for`, `foreach`, `switch`,
`fail`, `success`, locals, destructuring, `scoped`), and all expressions (operators, calls, indexing, ternary,
`?`, `!`, `is`, `as`, lambdas, cascades, list and dictionary literals, generic calls like `Tuple<Int>(1)`,
tasks, string interpolation) and optional semicolons.

- The tree has the shape of Ring0's AST (`Ring0/ast.md`); `dumpSource` prints it like Ring0's `dump`,
  including resolved string escapes.
- **Corpus:** `scripts/runCorpus.sh` generates one test case per Ring0 test source (lowering, syntax,
  binding, flow, types, showcase) and per Ring1 source file, and compares Ring1's tree with Ring0's.
  124 cases, all identical but the showcase, including every Ring1 file: the parser parses its own source
  tree. The showcase differs only in the macro section and in computed dictionary keys.
  `scripts/diffParse.sh` shows where one file differs.
- `tests/parserTest.ev` holds five hand-picked cases, expected trees generated from Ring0.

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
| Parser, lexer and tests together | check ok; lowers to 192 functions, verifier: structure and semantics valid |
| Wire export | **blocked**: Sublang allows at most 32 functions per module (`SUBLANG-W001 count budget exceeded`), the lexer and its test lower to 45 functions including 4 generated text helpers |
| Self tests on Emerald (translated) | lexer 17 of 17, parser 5 of 5, corpus 123 of 124 cases pass (the showcase differs in macros); a deliberately wrong expectation fails as it should |
| Native run of the self tests through Sublang | not done (needs the wire export and a working Sublang backend) |

The function budget is a documented Sublang requirement (`Ring0/docs/lowering.md`, open backend
requirement 10), not a reason to merge small functions: a compiler written in Emvus has hundreds.
Sublang's own limits are 32 functions, 64 blocks per function, 4096 values per function and 32768
spans per module.

## Open

- Not parsed yet: macros and `quote` (the rest of the showcase), computed dictionary keys (`[key]: value`),
  statement-level cascade items, and error recovery that matches Ring0's diagnostics (Ring1 only produces
  error nodes).
- Wire export and native run, after Sublang raises the module budget and builds again.
- Token stream comparison with Ring0 on every syntax fixture: needs file input (`G1`) and a shared
  dump format; Ring0's `--tokens` prints `line:column kind text`.
- Parser, binder, null flow, lowering (see `Ring0/docs/plan.md`, Self-hosting).
