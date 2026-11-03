# Ring1

The first self-hosted stage of the Emvus compiler, written in Emvus and built by Ring0
(`Ring0/docs/plan.md`). Ring1 uses the **parameter-passing subset** decided in
`Ring0/docs/languageDecisions.md` (decision 3): primitive types, strings, enums, primitive records,
`Result`, and state kept in `List<Int>` parameters instead of objects with list fields.

## Lexer v0 (`src/lexer.ev`)

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

## State

| Check | Result |
|---|---|
| `ring0 src/lexer.ev --check` | ok |
| Lowering to Sublang IR (`--dump`) | verifier: structure valid, semantics valid |
| Wire export | **blocked**: Sublang allows at most 32 functions per module (`SUBLANG-W001 count budget exceeded`), the lexer lowers to 45 including 4 generated text helpers |
| Native run of the self test | not done (needs the wire export and a working Sublang backend) |

The function budget is a documented Sublang requirement (`Ring0/docs/lowering.md`, open backend
requirement 10), not a reason to merge small functions: a compiler written in Emvus has hundreds.
Sublang's own limits are 32 functions, 64 blocks per function, 4096 values per function and 32768
spans per module.

## Open

- Wire export and native run, after Sublang raises the module budget and builds again.
- Token stream comparison with Ring0 on every syntax fixture: needs file input (`G1`) and a shared
  dump format; Ring0's `--tokens` prints `line:column kind text`.
- Parser, binder, null flow, lowering (see `Ring0/docs/plan.md`, Self-hosting).
