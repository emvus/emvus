# Ring0 AST

Einheitlicher Knoten `Node(kind, text, line, column)` mit Kindern (`src/ring0/syntax/Node.ems`).
`node.dump(0)` gibt den Baum eingerückt aus. Maßgeblich sind die Kopfkommentare der Parser:

| Bereich | Datei |
| --- | --- |
| Datei, package, use | `parsing/TopLevelParser.ems` |
| Deklarationen, Mitglieder | `parsing/DeclMemberParser.ems`, `parsing/DeclHeaderParser.ems` |
| Typen | `parsing/TypeParser.ems` |
| Statements | `parsing/StatementParser.ems` |
| Ausdrücke | `parsing/ExpressionParser.ems` |

## Datei und Deklarationen

Jede Deklaration hat als Kinder zuerst `annotation*`, dann `modifiers`, danach die Spezifika.

| Kind | text | Weitere Kinder |
| --- | --- | --- |
| `file` | – | `package?`, `use*`, Deklarationen |
| `package` | `a.b` | – |
| `use` | – | `use-item*` (text = voller Pfad, optional Kind `alias`) |
| `annotation` | Name | Argumentausdrücke |
| `modifiers` | – | `modifier*` (public/private/protected/static/abstract/override/final) |
| `class` | Name | `where?`, `based?`, `implements?`, `body` |
| `data-class` | Name | `params`, `where?`, `based?`, `implements?`, `body?` |
| `record` | Name | `params`, `body?` |
| `interface` | Name | `where?`, `based?`, `body` |
| `enum` | Name | `body` (`enum-entry*`, danach Mitglieder) |
| `exception` | Name | `params?`, `based?`, `body?` |
| `macro` | Name | `params`, `targets` (`target*`), `block` |
| `method` | Name | `return-type?` (Typ), `params`, `where?`, `block` \| `placeholder` \| nichts |
| `constructor` | Name | `params`, `super-call?` (text super/this, Argumente), `block` |
| `property` | Name | Typ, `accessors` (`accessor` text get/set), Initializer? |
| `field` | Name | Typ, Initializer? |
| `variable` | Name | Typ (`type var`), Initializer? (z. B. `final var X = 1`) |
| `params` | – | `param*` (text = Name; `annotation*`, `modifiers`, Typ, Default?) |
| `where` | – | `typeparam*` (text = Name; Bounds als Typ-Knoten) |
| `based` / `implements` | – | Typ-Knoten |
| `body` | – | Mitglieder |

## Typen

`type` (text = Basisname, Kinder = Typargumente), `tuple-type` (Kinder = Elementtypen), `var` für Inferenz.

## Statements

`block`, `placeholder`, `local`, `init`, `destructure`, `binding`, `wildcard`, `cascade`, `cascade-item`,
`if`, `while`, `for`, `foreach`, `return`, `fail`, `success`, `break`, `continue`, `switch`, `case`,
`pattern-success`, `pattern-error`, `pattern-name`, `pattern-value`, `assign`, `expr-stmt`.
Kinderreihenfolge: Kopfkommentar in `StatementParser.ems`.

## Ausdrücke

`int-literal`, `float-literal`, `string`, `bool-literal`, `null-literal`, `name`, `this`, `generic-ref`,
`splice`, `member`, `call`, `index`, `propagate` (`?`), `unwrap` (`!`), `postfix`, `unary`, `binary`,
`ternary`, `assign`, `is`, `as`, `cascade`, `cascade-section`, `lambda`, `list-literal`, `dict-literal`,
`dict-entry`, `task` (fiber/virtual/thread), `switch`, `case`, `pattern`, `pattern-literal`, `quote`, `error`.
Details: Kopfkommentar in `ExpressionParser.ems`.

## Prüfung

`scripts/run-sandbox.sh tests/showcase.ev` baut Ring0 in der Sandbox und gibt den Baum aus
(`--tokens` zeigt nur Tokens). `tests/showcase.ev` ist der Sprachentwurf und parst ohne Diagnostics.
