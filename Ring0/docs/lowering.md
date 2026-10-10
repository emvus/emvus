# Lowering Emvus to Sublang

Status: working end to end for a small subset. An `.ev` file is parsed, checked, lowered to
Sublang High IR, exported as `.sublang-wire`, compiled by the standalone Sublang compiler and
run natively. Source: `src/ring0/lowering/`, entry `src/LoweringMain.ems`.

## Pipeline

```text
.ev -> Lexer -> Parser -> Binder (gate) -> ProgramLowerer -> SublangModule
    -> SublangWire.write -> .sublang-wire
    -> sublang emit-llvm (Sublang's own scripts/sublang-build.sh) -> LLVM -> native -> run
```

`scripts/runLoweringSandbox.sh [--run] [--dump] <file.ev>...` runs both stages in capped
sandboxes (6 GB RAM, no swap, no network, timeouts):

- stage A builds `LoweringMain.ems` with the Emerald toolchain together with the frontend
  and the Sublang sources, then lowers each file and writes its wire file;
- stage B calls Sublang's `scripts/sublang-build.sh` for each wire file.

Choice of route: the wire format keeps Ring0 free of the LLVM backend. Ring0 links only the
IR builder and the wire writer; code generation stays in the standalone `sublang` binary.
`--dump` prints the readable Sublang dump and the verifier verdict instead.
`scripts/checkLowering.sh` runs all fixtures in `tests/lowering/` in one bundled run and
compares the program output with `tests/lowering/expected/<name>.out`; a fixture whose first
line is `// expect-error: <fragment>` must be rejected with that diagnostic.

## Program result

The native entry wrapper calls the module entry `() -> Int`, prints its `i64` result and
exits successfully (the value is not an exit code). `static method<Int> main` therefore is
the only observable output of an Emvus program on this target.

## What lowers

- Top-level methods and `static method main` (becomes the module entry), self recursion,
  direct calls between methods (callees are emitted first).
- `Int`, `Bool`/`Boolean`, `Float`, `String` values as locals, parameters and returns.
- Int arithmetic `+ - * / %` with `overflow=trap` (one `emvus.integer_failure` abort record),
  comparisons, `!`, unary `-`, short-circuit `&&`/`||`.
- Float literals (converted to IEEE-754 bits by `values/FloatBits`, round to nearest even,
  at most 18 significant digits, magnitude 1e-18 to 9e18), `+ - * /` with `rne`, ordered
  comparisons (`!=` is unordered), unary `-` as multiplication by -1.0.
- Static strings: literals, `length()`, `==`, `!=`.
- Value records with `Int`/`Bool`/`Float` fields: `record P(Int x, Int y)`, construction
  `P(1, 2)`, field reads `p.x`, as parameters and return values.
- `if` without else, `while`, `for`, `break`, `continue`, `return`, assignment, compound
  assignment, `i++`/`i--` statements.

Mutable locals map to SSA: a `VariableEnv` maps each local to its current value; at joins
only the variables the construct may reassign (`AssignedNames`) travel as block parameters.

## What does not lower (diagnostics, not invented IR)

`println`, string interpolation, other string members, records inside records, `data class`,
classes, `Result`/`fail`/`success`/`?`, null and nullable flow, lambdas, collections,
tuples, switch, mutual recursion, Float `%`, mixed Int/Float arithmetic, and Float to Int
conversion (none exists in Sublang).

## Open contract questions for Sublang

1. **No output primitive.** External calls are rejected by the native gate ("unknown external
   calls are not natively allowed"), so `println` cannot be lowered; only main's Int is
   observable. A runtime-provider contract or an intrinsic such as `io.print` is needed.
2. **No runtime string building.** Strings are static (`const.string`, `string.length`,
   `string.byte`, `string.equal`); interpolation and concatenation need a dynamic string
   representation with an ownership rule.
3. **No forward declaration.** A call needs the callee's return type at emission, and the
   builder cannot re-enter a function, so mutual recursion cannot be built.
4. **`Result<T, E>` as a value.** `fail`, `success` and `?` need a tagged aggregate or the
   failure/unwinding model; the abort-only startup profile cannot represent a recoverable
   failure.
5. **Null.** The IR has no nullable reference or checked unwrap; Emvus null states are a
   frontend analysis and have nothing to lower to yet.
6. **Float/Int conversion** and `float.rem` are missing, so Float results can only be observed
   through comparisons.
7. **Integer division.** Emvus truncates toward zero and treats division by zero as an error;
   the fixtures do not exercise `int.div`/`int.rem` edge cases (`INT_MIN / -1`) yet.
8. **Case-insensitive names.** Resolved in the frontend; Sublang names keep the original
   spelling and are case-sensitive.
9. **Typed binder output.** The binder validates but does not annotate the AST with types, so
   lowering re-derives value kinds. Anything beyond this subset needs a typed tree or a side
   table keyed by node.
10. **Records in records and string fields** need record/aggregate nesting or reference
    semantics from the value-record contract.

## Implementation notes (Emerald quirks)

- Sublang keeps strings by reference. Names and string constants taken from the AST are held
  in a `RetainedPool` that must outlive the module.
- The `SublangBuilder` must be created by the caller of `ProgramLowerer`; a builder created
  inside and referenced by the context is released together with its module.
- Lowerers are stateless wrappers around `LoweringContext` and resolve each other through
  `LoweringPrelude` to avoid cyclic `use`.
- Flow rejects reassigning object locals; helpers return values instead.
- Operations live on `builder.ops()`; blocks, parameters and types on the builder.
- The stage A build uses the live Sublang working tree (`RING0_SUBLANG_CHECKOUT`) and, by
  default, a `git archive` snapshot of the committed frontend (`RING0_BASE_SRC` overrides it).
