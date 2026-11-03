# Contributing

## Commit messages: Conventional Commits

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[(scope)][!]: <description>

[body]

[footer(s)]
```

| Type | Use for | Version effect |
|---|---|---|
| `feat` | a new capability | minor |
| `fix` | a bug fix | patch |
| `perf` | a change that makes something faster | patch |
| `refactor` | a change that neither fixes nor adds | none |
| `docs` | documentation only | none |
| `test` | tests only | none |
| `build`, `ci`, `chore` | build scripts, pipelines, upkeep | none |

- The description is imperative, lower case and has no trailing period (`feat(parser): handle macros`).
- A scope names the part that changes: `ring0`, `ring1`, `parser`, `binder`, `lexer`, `lowering`, `emvusc`, `vscode`, `docs`.
- A breaking change is marked with `!` after the type or scope (`feat(wire)!: drop wire version 1`) and explained
  in a `BREAKING CHANGE:` footer.
- One logical change per commit; the body says why, not what.

## Versions: Semantic Versioning

Versions follow [Semantic Versioning 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH`, where a breaking change
raises MAJOR, a backward-compatible feature MINOR and a fix PATCH. While MAJOR is 0 the interface is not stable
and a minor version may break compatibility.

Builds from the development branch report `0.1.0-indev.<first 8 characters of the commit>`: a pre-release of
0.1.0 whose identifier names the exact commit. ``scripts/stampVersion.sh`` writes it before a build. (SemVer forbids leading
zeros in an all-digit identifier; a commit hash that is only digits and starts with 0 would need another form.)
Releases are tags `vMAJOR.MINOR.PATCH` and carry no `-indev` suffix.

## Code style

The code follows the Pureline specification in `PURELINE_SPECIFICATION_1.5.md`.
