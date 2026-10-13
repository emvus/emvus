# Path to the first self-hosted Emvus compiler

Goal: a compiler written in Emvus (lexer, parser, binder, lowering, wire output) that Ring0
compiles to a native executable, which then compiles itself.

Ring0's frontend is considered frozen for this goal: only fixes that block a self-hosted
program are accepted. Everything below is a requirement on **Ring0's lowering** or on the
**Sublang backend**. Nothing here is implemented; every operation name marked *proposed* is a
suggestion for Sublang and not an existing opcode.

## What a compiler needs and what is missing today

| Need | Today | Gate |
|---|---|---|
| Read a source file, print diagnostics and the produced wire | no input or output primitive | G1 |
| Program arguments (`Process.args()`) | not lowered | G1 |
| Byte-wise text access (`charAt`, `substring`, comparison) | List<Byte> and `text.slice` exist; Emvus semantics (byte vs character) are undefined | G2 (Ring0 plus a language decision) |
| Tokens and AST nodes holding text and child nodes | no reference fields in records, lists or classes | G3 |
| Parent/child links, shared symbol and type objects | no shared references | G4 |
| Optional results (symbol not found) | no nullable or Option layout | G5 |
| Symbol tables | no map layout | G6 |
| Static tables (keyword lists, kind constants) | no top-level constants or static fields | G7 |

## Two routes

### Route A: data-oriented bootstrap subset (needs G1, G2, G7 only)

Write the self-hosted compiler in a restricted style that today's lowering already supports:
text as a byte list, tokens and AST nodes as parallel `List<Int>` columns indexed by node id,
interned strings as one byte pool plus offset and length columns, symbol tables as sorted or
linear-probed `List<Int>` tables, errors as `Result<Int, E>`. Records of primitives, enums,
classes with primitive fields, generics and lambdas already lower.

- Pro: needs almost nothing from Sublang (two I/O primitives), so a first self-hosted lexer and
  parser can exist soon.
- Con: the code is not idiomatic Emvus and violates the spirit of Pureline's readability rules.
  It is a bootstrap stage ("Ring1"), meant to be replaced once G3 to G6 are available.

### Route B: idiomatic compiler (needs G1 to G7)

Write the compiler the way Ring0 is written (`Node`, `Token`, `List<Node>`, `Dictionary`).
Needs the full list of backend requirements below.

Recommendation: do Route A for the lexer first, because it finishes the I/O contract and exposes
what the lowering still lacks, while G3 to G6 are designed in Sublang.

## Gates

### G1: input, output, arguments (backend)

Proposed operations, all with an explicit observable effect and no hidden allocation:

| Proposed opcode | Operands (mode) | Result | Notes |
|---|---|---|---|
| `io.write_text` | `Ref<List<Byte>>` (borrow_read), `Int` stream (value; 1 stdout, 2 stderr) | `Int` (bytes written, negative on failure) | observable effect; ordering preserved by Flow |
| `io.read_file` | `Ref<List<Byte>>` path (borrow_read) | owned `Ref<List<Byte>>`, scope > 0 | failure is an `Int` code via `ext.eh.v1` or a tagged result, never silent |
| `process.arg_count` / `process.arg` | none / `Int` index (value) | `Int` / owned `Ref<List<Byte>>` | index out of range aborts |

The brief forbids external C calls, so these must be Sublang runtime operations, not FFI.
Ring0 side: lower `println`, `print`, `Std::Io::File.readAll`-style calls and `Process.args()`
to them; `main` with an `Int` exit code needs a separate decision (the entry currently prints
`main`'s Int).

### G2: byte-wise text (Ring0 plus language decision)

`list.get` on `List<Byte>` plus `byte.to_int`, `text.slice` and `text.equal` already exist, so
this gate is mostly lowering work. Open decision for the language: do `charAt`, `substring`,
`length()` and `indexOf` operate on UTF-8 bytes (what `length()` does today) or on characters?
Selfhost can proceed with bytes if the decision is documented: Emvus source is ASCII-structured
and string contents are opaque to the compiler.

Missing backend help (nice to have): `Byte` comparison, so `charAt(i) == 'a'` does not need a
conversion to Int first. Not required, the conversion works.

### G3: reference fields in records, lists and tuples (backend)

Today a record or list element is a primitive or a value record of primitives. Required:

- `Ref<List<Byte>>` (String) as a field of a class and of a value record, with the same
  ownership rule as for object fields: the container owns it, reads are borrowed views.
- `Ref<List<Byte>>` and `Ref<C>` as the element type of `Ref<List<E>>` (owned elements, borrowed
  reads that expire on mutation, which `list.borrow` already provides for class elements).
- Records containing such fields stay value records only if copying is defined (deep copy of the
  text). Otherwise lower `data class` to a class and document that it has reference identity of
  the contained text but value semantics at the language level through `copy()`.

### G4: shared references (backend)

Emvus objects and lists are references that can be aliased. Sublang fields own their child
exclusively, so a parent link or a symbol referenced from two nodes cannot be expressed.
Candidate designs (backend owner decides):

1. A counted shared reference type `Shared<C>` with `share.new`, `share.clone` (increments),
   `share.borrow_read`/`share.borrow_write` and release at scope end. Cycles leak by definition;
   document that the compiler accepts leaks for the process lifetime.
2. Arena/region ownership: every node allocated in a region that outlives all borrows, with
   non-owning `Ref` copies allowed inside the region. This fits a compiler (whole-program
   lifetime) and avoids counting cost.

Ring0 side: lower aliasing assignment of objects, lists and closures once such a type exists,
instead of rejecting it as it does now.

### G5: absence (backend or Ring0)

The checker already enforces null safety, so the lowering can use a plain layout:

- a nullable class or text reference as a pair (presence flag + reference) in a value record, or
- an `Option<T>` value record monomorphized per payload, as `Result<T,E>` already is.

This needs G3 for reference payloads; for `Int`/`Bool`/`Float` payloads Ring0 could lower
nullable values today without backend changes.

### G6: map layout (backend or library)

`Dictionary<String, V>` with `get`, `put`, `containsKey`, `remove`, iteration. Options: a
Sublang library module written in the High IR builder (open addressing over `List<Int>` plus key
pool; needs only G3 for `V` references), or a native operation family. A library module avoids a
new opcode set and keeps the backend small.

### G7: module-level constants and static fields (Ring0)

Literal `final var` constants can be inlined by the lowering. Mutable static fields need
module-level storage in Sublang; selfhost can avoid them by passing a context object.

## Suggested order

1. G1 in Sublang (smallest, unlocks any observable program).
2. G2 decision and lowering (`charAt`, `substring`, `indexOf`, `Std::Io::File`-style reads).
3. G7 for literal constants.
4. Route A lexer in Emvus, built by Ring0, checked against the Emerald-written Ring0 lexer on all
   fixtures (token streams must match).
5. G3, then G5 and G6 as a library; then G4 decision.
6. Route B parser/binder/lowering; first full self-host: Ring0-built Emvus compiler compiles its
   own source and the result produces an identical wire for the fixture set.
