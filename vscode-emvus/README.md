# Emvus for VS Code

Language support for **Emvus** (`.ev`), built from the language tests in `Ring0/tests`
(`syntax/`, `binding/`, `flow/`, `showcase.ev`) and the Ring0 front end.

## Features

| | |
|---|---|
| **Highlighting** | TextMate grammar: `package`/`use { a.b.[X, Y as Z] }`, `class`/`data class`/`record`/`interface`/`enum`/`exception`/`macro`, `method<T> name`, `where`/`based`/`implements`, `fail`/`success`/`?`/`!`, switch patterns, cascades `..`, `${…}` interpolation, `$(…)` splices, `quote …`, `fiber`/`virtual`/`thread`, annotations, block comments |
| **Snippets** | ~70: declarations, `Result` methods, guards, `switch` (value / Result / enum), cascade, destructuring, tasks, macros, quotes … |
| **Completion** | locals, parameters, members of the enclosing class, members after `.` / `..` with static typing (builtins, project classes, inheritance, generics, `Result<T,E>`, tasks, `List<T>`, `Dictionary<K,V>`), `use` paths, `@annotations` |
| **Auto-import** | types from other packages are suggested with their `use pkg.Type` inserted automatically; quick fix *Import 'pkg.Type'* |
| **Diagnostics** | syntax (same messages as Ring0), unknown names/types/members, argument counts, type mismatches, duplicates (case-insensitive), abstract methods, `implements`/`based`, default-parameter order, ignored `Result`, `fail`/`success`/`?` rules, switch completeness, unreachable `error(...)` patterns, **null-flow analysis** (maybe-null use, loop joins, short-circuit refinement, uninitialized properties) |
| **Navigation** | hover (with `//` doc comments), go to definition, references, document highlight, rename, document & workspace symbols, signature help |
| **Imports** | unused-import hints, *Organize imports* |
| **External checker** | optional: run a Ring0 build as `<checker> file.ev --check` on save |

## How it was derived

The extension front end (`src/server/{lexer,parser,model,checker}.ts`) is verified by
`test/spec.test.mjs` against **every** file in `Ring0/tests`:

* `syntax/n*.ev` – each `// expect: <fragment>@<line>` must be reported on that line
* `syntax/p*.ev` – `// expect-ok`: no syntax errors
* `binding/*.ev`, `flow/*.ev` – the first line `// expect: …` must be reported (`check ok` = no errors)
* `showcase.ev` – must check ok

`test/e2e.test.mjs` drives the real language server over stdio (completion, auto-import, quick fixes,
hover, definition, references, signature help, rename, organize imports).

## Settings

| Setting | Default | |
|---|---|---|
| `emvus.sourceRoots` | `["."]` | folders indexed (relative to the workspace folder) |
| `emvus.completion.autoImport` | `true` | suggest types of other packages |
| `emvus.diagnostics.unusedImports` | `true` | hint for unused `use` |
| `emvus.checker.path` | `""` | optional external checker binary |
| `emvus.checker.checkOnSave` | `false` | run it on save |

## Development

```bash
npm install
npm run build      # dist/extension.js, dist/server.js, dist/spec.cjs
npm test           # builds, then runs spec + e2e tests
npm run package    # emvus-lang-<version>.vsix
```

## Notes

* Symbols are case-insensitive (like the language): `Person` and `person` are the same declaration.
* The "standard library" is the compiler's builtin table (`BuiltinTypes`/`BuiltinMembers`), copied into
  `src/server/builtins.ts`; `std.collections.*` / `std.functional.*` import paths come from the language draft.
* Only definite type mismatches are reported (unknown or generic types never produce an error).
