# Open language decisions (proposals)

Scope: no C is written on the Emvus side. Output, exit status, file access and process arguments are
platform contracts of Sublang (`Sublang_Runtime_IR.md`, next steps 1 to 3: typed platform imports,
Linux file I/O and process arguments through IR). Ring0 lowers to those contracts once they exist; until
then they are the open gate G1. Nothing below asks for C source or an FFI.

Status: decision 1 is **accepted and implemented** except `indexOf`; decisions 2 and 3 are **proposed, not decided.** Each section states the facts found in Ring0 today, the options,
and a recommendation. Accepting one means updating `lowering.md`, `plan.md` and the fixtures it names.

## 1. Does `String` count UTF-8 bytes or characters?

Facts:

- A lowered `String` is an owned `Ref<List<Byte>>`. `length()` returns the byte count
  (`TextLowerer`, "Emvus does not yet define character length").
- The binder knows `String.charAt(Int):Char`, `substring(Int,Int)`, `indexOf(String)`, `split`, `trim`
  and a `Char` type, but the lexer has **no character literal** (`'a'`) and no fixture or showcase code
  uses `charAt`. `Char` exists on paper only.
- The self-hosted lexer reads ASCII-structured source; string contents are opaque to it
  (`selfhostRequirements.md`, G2).

Options:

| | Meaning | Cost | Risk |
|---|---|---|---|
| A. Bytes | indexes and lengths are UTF-8 byte offsets (like Go string indexing, Rust `str` slicing) | O(1), maps to `list.get` and `text.slice` | `substring` can cut a multi-byte sequence in two; surprising next to Java-like expectations |
| B. Code points | indexes count characters | `charAt`, `substring`, `length` become O(n) without an index; needs a UTF-8 decoder in the runtime IR | more runtime code before Ring1 can start; `Char` must become a 21-bit value |
| C. Bytes now, characters later | A for `length`, `substring`, `indexOf`; a new `byteAt(Int):Int`; `charAt` and `Char` stay reserved and are diagnosed until characters are defined | minimal | one more String member |

Recommendation: **C.** Ring1's lexer only needs byte comparisons, so `byteAt(i) == 97` is enough, and
no decision about `Char` has to be made under time pressure. Declare the byte semantics in the
language documents, make `substring` abort on out-of-range indexes (like list access) and leave
boundary checking for the day a character API exists. `length()` keeps its present meaning, so no
existing fixture changes.

Done: `String.byteAt` in `BuiltinMembers`; `byteAt` and `substring` lowered with `list.get` +
`byte.to_int` and `text.slice`; `charAt` diagnosed; fixtures `textByteAt`, `textByteAtOutOfRange`,
`textSubstringOutOfRange`, `textCharAtReserved`. Open: `indexOf` needs a generated search loop helper
and is not lowered yet.

## 2. Contract of `main`'s `Int`

Facts:

- The Sublang entry is `() -> Int`; the native program **prints** that Int. A `Void` main is wrapped and
  returns 0 (`EntryPoint`).
- Without an output primitive (G1) that printed Int is the only observable result. The run-checked lowering
  fixtures compare it (`tests/lowering/expected/*.out`).
- `main` with parameters is rejected until `Process.args()` exists.

Options:

| | Behavior | Consequence |
|---|---|---|
| A. Exit status | the Int becomes the process exit code (the OS keeps the low 8 bits), nothing is printed | every fixture's expected output moves to an exit-code check; results above 255 can no longer be compared (`179` fits, `1000` does not) |
| B. Keep printing | unchanged | not usable for a real compiler, which must report success through the exit status |
| C. Both, in stages | until `println` exists the entry prints (documented test-harness behavior); when G1 lands the Int becomes the exit status and fixtures that need a wide value use `println` | one switch, at the moment it is cheap |

Recommendation: **C.** Write the final contract down now (exit status, `Void` means 0, values outside
0..255 follow the OS), keep the printing entry as an explicitly named bootstrap behavior, and make the
switch part of the G1 work. The `checkLowering.sh` harness then reads the exit code instead of the
printed line.

## 3. The stable input subset of Ring1 (Route A)

Facts: `lowering.md` lists what lowers now and what is blocked. The blocked entries that matter for a
data-oriented lexer are class fields of list type, `List<String>`, records with String fields, tuples with
text, dictionaries, `null`, static fields and any output.

Proposed **Ring1 subset v0**, all of it lowering today or with this branch:

- Types: `Int`, `Bool`, `Float`, `String` as local, parameter, return value (literal, `+`, `${}`, `==`,
  `length()`, and the `byteAt`/`substring` of decision 1); enums; records and data classes of primitives;
  `Result<T,E>` with primitive `T` and primitive exception `E`.
- State lives in **lists passed as parameters**: `List<Int>` columns for token kind, start, length and
  line, with `List<Int>`/`List<Bool>` parameters mutated by the callee (`borrow_write`). A list cannot be a
  class field and cannot be reassigned in a branch or loop, so a lexer is a set of functions over
  parameters, not an object with fields.
- Control flow: `if`, `while`, `for`, `for-in`, `switch` over Int and enums, guard returns, recursion.
- Top-level literal constants for kinds and keyword codes (`final var TOKEN_IDENT = 1`, new in this branch).
- Generics and lambdas over primitives where they help.
- Excluded in v0: classes holding lists or objects, aliasing of objects, `List<String>`, `Dictionary`,
  `null`, `dynamic`, `fiber`, macros, static fields, printing.

Check for acceptance: the Ring1 lexer, written in this subset, produces a token stream equal to Ring0's
on every syntax fixture (`plan.md`, Self-hosting). Anything the lexer needs outside the subset is a
documented requirement, not a silent extension.

Open question for you: is it acceptable that Ring1 v0 is written in this parameter-passing style
(`selfhostRequirements.md`, Route A already assumes it), or should Ring1 wait for G3 and be written
idiomatically?
