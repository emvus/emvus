# Ring0 AST

Uniform node `Node(kind, text, line, column)` with children (`src/ring0/syntax/Node.ems`).
`node.dump(0)` prints the tree indented. The header comments of the parsers are authoritative:

| Area | File |
| --- | --- |
| File, package, use | `parsing/TopLevelParser.ems` |
| Declarations, members | `parsing/DeclMemberParser.ems`, `parsing/DeclHeaderParser.ems` |
| Types | `parsing/TypeParser.ems` |
| Statements | `parsing/StatementParser.ems` |
| Expressions | `parsing/ExpressionParser.ems` |

## File and declarations

Each declaration has the children `annotation*` first, then `modifiers`, then its specifics.

| Kind | text | Further children |
| --- | --- | --- |
| `file` | – | `package?`, `use*`, declarations |
| `package` | `a.b` | – |
| `use` | – | `use-item*` (text = full path, optional child `alias`) |
| `annotation` | name | argument expressions |
| `modifiers` | – | `modifier*` (public/private/protected/static/abstract/override/final) |
| `class` | name | `where?`, `based?`, `implements?`, `body` |
| `data-class` | name | `params`, `where?`, `based?`, `implements?`, `body?` |
| `record` | name | `params`, `body?` |
| `interface` | name | `where?`, `based?`, `body` |
| `enum` | name | `body` (`enum-entry*`, then members) |
| `exception` | name | `params?`, `based?`, `body?` |
| `macro` | name | `params`, `targets` (`target*`), `block` |
| `method` | name | `return-type?` (type), `params`, `where?`, `block` \| `placeholder` \| nothing |
| `constructor` | name | `params`, `super-call?` (text super/this, arguments), `block` |
| `property` | name | type, `accessors` (`accessor` text get/set), initializer? |
| `field` | name | type, initializer? |
| `variable` | name | type (`type var`), initializer? (e.g. `final var X = 1`) |
| `params` | – | `param*` (text = name; `annotation*`, `modifiers`, type, default?) |
| `where` | – | `typeparam*` (text = name; bounds as type nodes) |
| `based` / `implements` | – | type nodes |
| `body` | – | members |

## Types

`type` (text = base name, children = type arguments), `tuple-type` (children = element types), `var` for inference.

## Statements

`block`, `placeholder`, `local`, `init`, `destructure`, `binding`, `wildcard`, `cascade`, `cascade-item`,
`if`, `while`, `for`, `foreach`, `return`, `fail`, `success`, `break`, `continue`, `switch`, `case`,
`pattern-success`, `pattern-error`, `pattern-name`, `pattern-value`, `assign`, `expr-stmt`.
Child order: see the header comments in `parsing/statements/` (`StatementParser`, `LocalDeclarationParser`, `ControlFlowParser`, `StatementSwitchParser`).

## Expressions

`int-literal`, `float-literal`, `string`, `bool-literal`, `null-literal`, `name`, `this`, `generic-ref`,
`splice`, `member`, `call`, `index`, `propagate` (`?`), `unwrap` (`!`), `postfix`, `unary`, `binary`,
`ternary`, `assign`, `is`, `as`, `cascade`, `cascade-section`, `lambda`, `list-literal`, `dict-literal`,
`dict-entry`, `task` (fiber/virtual/thread), `switch`, `case`, `pattern`, `pattern-literal`, `quote`, `error`.
Details: see the header comment in `parsing/expressions/ExpressionParser.ems`.

## Verification

`scripts/run-sandbox.sh tests/showcase.ev` builds Ring0 in the sandbox and prints the tree
(`--tokens` prints tokens only). `tests/showcase.ev` is the language draft and parses without diagnostics.

## Hardening (frontend)

- `string`: `text` stays the raw text (escapes resolved). Each successfully parsed `${expression}` yields a child
  `interpolation` with the expression as its only child. Unparseable parts (e.g. `$(...)` in macros) stay in the raw text only.
- `assign`: `text` is `=`, `+=`, `-=`, `*=`, `/=` or `%=`.
- Local variables and loop variables may be named like the keywords `exception`, `method`, `macro`, `record`, `class`,
  `interface`, `enum`, `package`, `use`.
- `?` at line end is a ternary if, within the next 3 lines at bracket depth 0, a `:` follows before another
  `?`, `;`, `->` or `=`; otherwise it is propagation.
- Tests: `scripts/check-syntax.sh` (negative/positive tests under `tests/syntax/`, AST comparison `tests/golden/showcase.ast`).

## Cascades

`receiver ..a() ..x = 1 ..b()` is ONE `cascade` node: child 0 is the receiver, every further child is a
`cascade-section` whose single child is the member/call chain relative to the receiver, or an `assign`
whose target is that chain.

```text
cascade
  call (the receiver, e.g. Person("Anna", 30))
  cascade-section
    call
      name birthday
  cascade-section
    assign =
      name age
      int-literal 40
  cascade-section
    call
      name birthday
```

The value of `..x = value` ends at the next `..`: that `..` starts the following section instead of
cascading on the value. Inside brackets, argument lists and blocks cascades work again as usual
(`..x = compute(a ..b())`). Earlier versions produced a nested `cascade` on the literal for
`..age = 40 ..birthday()`; that shape no longer occurs.

`cascade` with `cascade-item` children is a statement-level fallback for a `..` that follows a complete
expression the expression parser did not absorb (for example after `x is T`).

## Parser layout

```text
syntax/                      Token, Node, ParserState, AstKinds (node kind constants), SyntaxPrelude
syntax/lexing/               Lexer, LexerCursor, LexerRules, LexerTokenReader
syntax/parsing/              Parser, TopLevelParser, TypeParser
syntax/parsing/expressions/  ExpressionParser, BinaryExpressionParser, UnaryPostfixParser, TernaryLookahead,
                             PrimaryParser, StringPartsParser
syntax/parsing/expressions/literals/  CollectionLiteralParser, LambdaParser, QuoteParser
syntax/parsing/switches/     SwitchParser, SwitchPatternParser          (expression switch)
syntax/parsing/statements/   StatementParser, StatementExpressionParser, LocalDeclarationParser,
                             ControlFlowParser, StatementSwitchParser   (statement switch)
syntax/parsing/declarations/ DeclMemberParser, DeclHeaderParser, ParameterParser, MethodParser, FieldParser,
                             TypeDeclarationParser, EnumParser, MacroParser
```
