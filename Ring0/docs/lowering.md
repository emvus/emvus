# Lowering Emvus to Sublang

Pipeline (all compiler and program runs happen in capped Docker sandboxes: 6,000,000,000 bytes
RAM and the same RAM+swap, no network, timeouts, one run at a time):

```text
.ev source -> Lexer -> Parser -> Binder (types, symbols, null flow)
           -> ring0/lowering -> Sublang High IR -> .sublang-wire (v2)
           -> sublang-build.sh --flow=on --optimind=on -> LLVM -> native executable
```

```bash
scripts/runLoweringSandbox.sh --run tests/lowering/textBasics.ev   # build, run, print the result
scripts/runLoweringSandbox.sh --dump file.ev                       # readable IR and verifier verdict
scripts/checkLowering.sh                                           # all fixtures, one bundled run
```

`--run` prints the program's Int result (the native entry prints `main`'s Int), then the
`optimind:`, `effects:` and `lowering:` lines of the pipeline plan (`<binary>.plan`).
`RING0_FLOW` and `RING0_OPTIMIND` override the defaults (`on`, `on`) for bisecting.

The Sublang checkout is read-only input (`RING0_SUBLANG_CHECKOUT`); nothing is copied into either
repository. The frontend is taken from `git archive HEAD` unless `RING0_BASE_SRC` is set, so
commit frontend changes before testing against them.

## Capability matrix

| Emvus feature | State | Mapping or backend requirement |
|---|---|---|
| `Int` (Int64) | lowers now | every operation uses overflow mode `trap`; `int.div`/`int.rem` truncate toward zero; `/` by zero and `Int.MIN / -1` abort (fixtures `divideByZero`, `minDivide`) |
| `Bool`, `Float` | lowers now | Float arithmetic is `float.*` with `rne`; comparisons use ordered predicates, `!=` is unordered |
| Literals, locals, parameters, assignments, `+=`, `++` | lowers now | locals are SSA values; join points become block parameters |
| `if`, `while`, `for`, `break`, `continue`, guard returns | lowers now | |
| Direct calls, recursion, forward references, mutual recursion | lowers now | all signatures are declared before bodies are emitted; the context owns a `SublangCursor` and enters functions by id |
| `main` returning `Int` or `Void` | lowers now | Void `main` is wrapped into an `() -> Int` entry returning 0 |
| `String` values, `+`, `${}` of String/Int/Bool, `==`, `!=`, `length()` | lowers now | owned `List<Byte>` in a per-function text scope; parameters `borrow_read`; locals are cells assigned by copy; returns copy into an owned list (`returnOwned`) |
| `Float` or other types in `${}` | blocked | backend requirement: float/decimal formatting primitive |
| String `substring`, `contains`, `split`, character length | blocked | `text.slice` exists but Emvus has not defined character vs byte semantics; `length()` counts UTF-8 bytes |
| `record`, `data class` (primitive fields) | lowers now | Sublang value records; constructor defaults, `copy()`, `withX()`, positional destructuring `var { a, _ }` |
| Records with String/record/List fields, data class methods | blocked | backend requirement: reference fields in value records, or class lowering for data classes |
| `exception` types | lowers now | value records of their primitive fields (a hidden `code` field when none); built-in `Exception`, `IOException`, `UnknownCaseException` |
| Exception messages (`SaveFileException("text")`, `.message`) | blocked | the message is text; records cannot hold it. Diagnosed, never dropped |
| Exception inheritance (`based` on a declared exception), typed catch of a subtype | blocked | needs class hierarchies for values (`ext.oo.v1` dispatch over exceptions) |
| `Result<T, E>` with T in Int/Bool/Float/Void, E a primitive exception | lowers now | monomorphized value record: tag, value, flattened error fields. `fail`, `success`, `return`, `?` (same error type), `!` (abort), `orElse`, `isSuccess()`, `isError()`, `switch` with `success(v)` / `error(Type e)` |
| `Result.map`, `mapError` | blocked | need function values |
| `Result` of String/record payloads | blocked | same record limitation as above |
| `switch` over Int/Bool/String literals with catch-all, statement and expression | lowers now | comparison chain; arms are blocks; joins carry reassigned variables or the arm value |
| `enum` (entries only) and `switch` over enums | lowers now | entries are Int ordinals (kind `Enum:<name>`); a switch that names every entry needs no catch-all; enum members (methods, properties) are blocked |
| `panic(...)` | lowers now | abort failure; the message cannot be printed (no output channel) |
| `println` / `print` | blocked | backend requirement: output primitive (see below) |
| Top-level `final var` constants | blocked | not implemented in this stage (literal constants could be inlined) |
| Null, nullable flow values | blocked | backend requirement: nullable reference or an Option layout; the checker already enforces null safety |
| `class` with fields, properties (`{ get, set }`, initializers), constructors, methods, `static` members, `this`, bare member names | lowers now | one Sublang class per Emvus class, all derived from the synthetic root `emvus.Object` (tag field); see "Objects" below |
| `based` single inheritance, `: super(...)`, `abstract`, `override`, inherited members | lowers now | base constructors are inlined into the derived constructor; inherited methods are compiled once per class |
| `interface`, `implements`, interface-typed variables, parameters and calls | lowers now | closed-world dispatch groups over the root class (`call.virtual`) |
| `is T` over class and interface types | lowers now | tag comparison against every conforming concrete class |
| `as T` upcast to a base class or interface | lowers now | owned `class.upcast` for a fresh object, read-only view otherwise |
| `as T` downcast | partly | only to a class without registered descendants (Sublang's `class.downcast` checks one exact tag) |
| `scoped var` | lowers now | an explicit scope that ends with the enclosing block and on every `return`, `break` and `continue` out of it |
| Cascade `..` (method calls and property assignment) | lowers now | one receiver, sections act on it, the cascade's value is the receiver |
| Object-typed locals, parameters, fields, returns | lowers now with limits | a fresh object may be stored, moved or returned; an existing object reference cannot be stored in a field or returned owned (no shared ownership in Sublang); object variables cannot be reassigned inside a branch or loop |
| Virtual members that write through `this` or an object parameter | blocked | backend requirement: mutable views for `class.upcast` / `class.downcast` |
| Virtual members that return `String` or an object | blocked | backend requirement: a scope operand on `call.virtual` |
| `super.method()` calls | blocked | needs a mutable upcast view of `this` |
| Static fields | blocked | no module-level storage in Sublang |
| `List<T>` with T in Int, Bool, Float, records, tuples, classes: literal, `[]`, `add`, `get`/`xs[i]`, `set`, `xs[i] = v`, `+=`, `++`, `size()`/`length()`, `isEmpty()`, `clear()`, `for (T x in xs)` | lowers now | owned `Ref<List<E>>` in the function's owner scope, reference semantics (aliases share the list); see "Lists" |
| `List` of String, of lists, of function values | blocked | backend requirement: reference elements in lists |
| `List` as a class field | blocked | backend requirement: list-typed class fields |
| `map`, `filter`, `reduce`, `forEach` on a list | lowers now | counted loop that calls the function value; `map`/`filter` need a lowerable element kind of the result |
| Tuples `[A, B]` of Int/Bool/Float: literal, `t[0]` (literal index), destructuring `var { a, b } = t` | lowers now | value record `Tuple$A$B` per shape |
| Tuples with String, record or object elements | blocked | backend requirement: reference fields in value records |
| Generic methods (`where T`, bounds `T: Comparable<T>`) | lowers now | monomorphized per instantiation found from the checker's type arguments; `compareTo`/`equals` are provided for Int, Float, Bool |
| Generic classes, records and data classes | lowers now | one class/record per instantiation (`Box<Int>`), including as list elements and in other generic instantiations; see "Generics" |
| Lambdas, `Function<A,B>`, `BiFunction<A,B,C>`, `Runnable`, function values passed, stored and returned | lowers now | a synthesized class per lambda implementing a synthetic interface per function type; captures are copies of Int, Bool, Float, String, record and enum values; see "Lambdas" |
| Lambdas that capture an object, a list, a function value or `this` | blocked | backend requirement: shared references (Sublang fields own their child exclusively) |
| Functions returning String or a list from a lambda or virtual member | blocked | backend requirement: a scope operand on `call.virtual` |
| Conditional expression `c ? a : b` | lowers now | blocks joined by a block parameter; only Int, Bool, Float, record and enum results |
| Dictionaries `{ "k": v }` | blocked | backend requirement: a Map layout (see below) |
| `fiber` / `virtual` / `thread`, `await` | blocked | backend requirement: tasks (see below) |
| Macros, `quote` | not a lowering concern | expanded before lowering; Ring0 has no macro expander yet, a program that still contains them is diagnosed |
| `dynamic` | blocked | the Dyn library covers nil/bool/int/float/text only, no objects or lists |

## What the lowering guarantees

- Emvus semantics are not weakened to fit the backend: a construct the backend cannot express is
  a diagnostic that names the missing capability (`Lowering: ... backend requirement ...`).
- Binder annotations are consumed: every lowered expression is cross-checked against the
  checker's static type (`Node.type()`); a disagreement is reported instead of miscompiled.
- Overflow, division and bounds failures abort with the module's abort failure action.

## Objects

All Emvus classes derive from one synthetic root class, `emvus.Object`, whose only field is the
dispatch tag. That is what lets an interface value (a reference to the root) hold an instance of
any class, and it gives every class a registered tag for `is` and for dispatch.

| Emvus | Sublang |
|---|---|
| class `C` | class type `C`; fields = inherited fields first (Sublang's prefix rule), then own fields and properties |
| property / field | one class field (initializer expression runs before the constructor body) |
| constructor | function `C.new/arity` that allocates in its own scope, initializes the tag and fields, and `returnOwned`s the object |
| instance method | function `C.m/arity(this: Ref<C>, ...)`; `this` is `borrow_read`, or `borrow_write` when the body writes through it |
| inherited method | compiled again for each derived class so a mutating base method can run on a derived object (an upcast view would be read-only) |
| virtual method | member of a dispatch group keyed by name, parameter kinds and return kind; each concrete class registers a wrapper that downcasts to its exact class and calls its own copy; classes without an implementation share an aborting stub |

Ownership rules, decided per value:

- A constructor or call result is a fresh, owned reference adopted into the caller's scope (the
  function-level scope, or the scope of a `scoped var` while its initializer runs).
- A named object local is that owned reference; `this`, object parameters and field reads are
  borrowed views and cannot be moved, stored or returned.
- Object parameters are `borrow_read`, or `borrow_write` when a fixpoint over assignments, `++`,
  cascades and mutating calls shows the body writes through them (`MutationAnalysis`).
- Assigning a derived object to a base or interface variable moves it with an owned upcast when
  the source is a fresh temporary and takes a read-only view otherwise (aliases of one object).
- Text fields hold an owned copy: a store copies the bytes first (value semantics), a read is a
  borrowed view.

The checker resolves identifiers without regard to case, so a property named like a class
(`Engine engine`) makes a call `Engine(...)` read the property; fixtures avoid such names.

## Lists

A list value is a `Ref<List<E>>` created with `list.new` in the function's owner scope (the same
scope that owns objects and text temporaries). Emvus lists are references: `List<Int> b = a`
makes `b` another name for the same list, and `b.add(1)` is visible through `a`. That is exactly
what Sublang's reference values express, so no copy is made; mutation analysis gives the
parameter `borrow_write` when a callee adds to, sets in or clears a list, and `borrow_read`
otherwise.

| Operation | Lowering | Notes |
|---|---|---|
| `[a, b]`, `[]` | `list.new` + `list.push` | element type from the checker's annotation; a class element must be a fresh temporary |
| `xs[i]`, `xs.get(i)` | `list.get` (primitive, record, tuple) / `list.borrow` (class) | a class element is a read-only view that expires on the next mutation |
| `xs[i] = v`, `xs.set(i, v)`, `+=`, `++` | `list.set` / `list.replace` (class element, fresh value) | |
| `xs.add(v)` | `list.push` | class elements are consumed (moved into the list) |
| `size()`, `length()`, `isEmpty()`, `clear()` | `list.length`, comparison, `list.clear` | |
| `for (T x in xs)` | counted loop over `$list`, `$len`, `$i` | the length is read once: appending in the body does not extend the iteration, shrinking makes the next read abort |

Bounds failures abort (`list.get`, `list.borrow`, `list.set`). A list can be passed, returned
(owned, from a fresh list or an owner local) and stored in a local; it cannot be reassigned
inside a branch or loop (no reference block parameters) and cannot be a class field.

Value semantics that are *not* silently changed: reading a primitive or record element copies it
(so mutation of the list afterwards is not visible through the copy), reading a class element
yields a view, and storing an existing object in a list is rejected (aliasing would need shared
ownership) instead of moving it and invalidating the caller's name.

## Tuples

`[A, B]` is a value record `Tuple$A$B` with fields `item0`, `item1`, ... (Sublang records hold
primitive fields only, so every element is Int, Bool or Float). The literal, `t[0]` with a literal
index and positional destructuring are record operations. A computed index is rejected because
the element type would not be static.

## Generics

Generic declarations are monomorphized. `InstanceDiscovery` runs before any signature is
declared: it scans the program (and, to a fixpoint, every instance it creates) for calls of
generic methods (using the checker's `typeArgs`) and for type texts that apply a generic class,
record or data class (`Box<Int>`, `Pair<Int,Float>`). Each instantiation becomes an ordinary
method, class or record registered under the key `Box<Int>`, with a type-parameter frame
(`T=Int`) that is active while its signatures and body are declared and emitted. Bounds
(`T: Comparable<T>`) need no separate check: the body is lowered for the concrete kind, so
`a.compareTo(b)` resolves on Int, Float or Bool (other kinds are diagnosed when the member does
not exist). More than 128 instantiations are diagnosed (recursive instantiation).

Limits: generic interfaces and generic members inside a class are diagnosed; an instance is
found only if its type text appears somewhere the discovery scans (declarations, annotated
expressions); generic classes with virtual members and bases are supported through the ordinary
class pipeline but are not fixture-tested.

## Lambdas

Sublang has no closure opcode; its tested pattern is an object holding the captured environment
plus closed call targets. Ring0 maps every lambda onto that pattern with the class machinery:

- every function type is a synthetic interface `Fn$<params>$to$<result>` with one member `invoke`;
- every lambda expression becomes a class `Lambda$n` that implements the interface of its type,
  with one field per captured variable, a constructor that stores the captures and an `invoke`
  method holding the lambda body;
- creating the lambda calls the constructor (the object is owned by the function scope), and
  `f(x)` on a local or parameter of function type is a virtual `invoke` through the interface's
  dispatch group.

Captures are copies made when the lambda is created (Emvus captures by value). A lambda that
needs an object, a list, a function value or `this` from its environment is diagnosed:
Sublang class fields own their child exclusively, so the closure cannot hold the same object as
the creator (backend requirement: shared references such as Bond for plain classes).
A function value can be passed, stored in a local, returned owned from a function and applied.
The `invoke` members return primitives, records and enums; returning a String or a list through
a virtual call is blocked by the missing scope operand on `call.virtual`.

`map`, `filter`, `reduce` and `forEach` are lowered inline as loops over synthetic locals
(`$src`, `$fn`, `$res`, `$acc`, `$e`) that call the function value once per element.

## Value representations

| Emvus | Sublang |
|---|---|
| Int / Bool / Float | `Int` / `Bool` / `Float` |
| String | `Ref<List<Byte>>` owned in the function's text scope, or `borrow_read` parameter |
| record / data class / exception | value record |
| `Result<T,E>` | value record `Result$T$E`: `tag`, `value`, `e_<field>...` |
| `List<E>` | `Ref<List<E>>`, kind `List:<element kind>` |
| tuple `[A,B]` | value record `Tuple$A$B` |
| function type | `Ref` to the synthetic interface root, kind `Class:Fn$...` |
| generic instance | the monomorphized class or record `Box<Int>` |
| Void | `Void` |

### String ownership

- A function that uses text opens one scope in its entry block; all text temporaries live there until
  the function returns (memory is released at function exit, not per statement).
- A `String` parameter is borrowed read-only. When the body assigns it, a local copy is made at entry.
- A `String` local is a cell: assignment copies bytes into it (`emvus.text.assign`), so aliases keep
  value semantics. Reference block parameters are therefore never needed for text.
- Returning a String copies it into a fresh owned list and uses `returnOwned`; the caller adopts it
  into its own text scope (`call.direct` with an owned result).
- Int and Bool are appended in place by generated helpers (`emvus.text.appendInt`,
  `emvus.text.appendBool`): digits are collected on the non-positive magnitude so `Int.MIN` needs no
  overflowing negation.

## Open backend requirements

0. **Objects.** (a) Mutable views for `class.upcast` and `class.downcast`, so virtual members and
   base-typed variables can write. (b) A scope operand on `call.virtual`, so a virtual member can
   return a `String` or an object. (c) Shared ownership of plain classes (Emvus object references
   alias freely; Sublang fields own their child exclusively) to store an existing reference in a
   field or return a borrowed one. (d) Reference block parameters for owned objects, so an object
   variable can be reassigned in a branch or loop. (e) Subtree-aware checked downcast. (f) Static
   storage for static fields.

1. **Output primitive.** The native entry prints only `main`'s Int. A minimal contract that would
   unblock `println`: an intrinsic `io.write_text(Ref<List<Byte>> borrow_read) -> Void` (and a static
   String variant) with an `observable` effect, bound to the target's stdout and verified like other
   provider calls. Without it Emvus programs communicate only through their exit-path Int.
2. **Reference fields in value records**, or value-semantics text inside records (exception messages,
   data classes with String fields).
3. **Nullable references** or an explicit Option representation (null-flow is proven by the checker but
   has no backing type).
4. **Exception values with inheritance** (`based`, typed `error(Sub e)`): class hierarchies for
   plain values.
5. **Formatting primitives** for Float (and decimal Int with width/radix) so `${float}` can lower.
6. **Text operations:** character-aware length, substring by character, search, split.
7. **Shared references**, the single largest remaining gap: Emvus object, list and closure
   references alias freely, Sublang owners are exclusive. It blocks capturing objects, lists and
   function values in lambdas, storing an existing object in a field or list, returning a borrowed
   object, and reassigning object variables in branches and loops. A `Bond`-like shared-ownership
   mode for plain classes and lists would unlock all of them (items 0c and 0d above are special cases).
7a. **List elements that are references** (dynamic text, nested lists, function values) and
   **list-typed class fields**.
7b. **A Map layout** (`Map<K,V>` with checked get/put/contains/remove, iteration order and
   Int/String/record keys) for dictionary literals; **tasks** (a spawn/join primitive and a
   memory model) for `fiber`, `virtual`, `thread` and `await`.
7c. **`Result.map` / `mapError`** are now expressible as lambdas but not implemented: they need a
   generic function-typed Result payload, which depends on item 2.
8. **Enum values** are expressible as Int tags in the frontend (planned), but need a distinct type to
   keep Emvus' type safety visible in the IR.
9. **Backend defect (reproducible): `emit-llvm` aborts** with `Emerald Flow allocation failed (...)`
   for `tests/lowering/backendCrash.ev`: an owned call result (`greet(...)`), two calls of the
   in-place text helpers and a branch on `text.equal` in one function. It aborts with `--flow=off`
   and `--optimind=off` too, so it happens before Flow and Optimind. Smaller variants (one helper
   call, no equality, no owned call) compile and run. `checkLowering.sh` marks the fixture
   `expect-backend-crash` and fails when it stops reproducing so this entry gets updated.

## Observations about Emerald (frontend implementation language)

- The loader resolves a class by the file named exactly like it (case-sensitive) and each class
  needs a `use`; classes are listed in `LoweringPrelude` to avoid cyclic imports.
- Flow v1 rejects reassigning object locals: lowerers return new values from helpers instead.
- A `substring` result is a view: copy it (`+ ""`) before storing, otherwise the stored kind string
  becomes garbage (this caused an apparent type mismatch during development).
- Class names must be unique across the project: a lowering class named `TypeText` collided with
  the binder's.

## Files

```text
ring0/lowering/                ProgramLowerer, LoweringContext, LoweredValue, WireExport, LoweringPrelude
ring0/lowering/program/        DeclarationCollector
ring0/lowering/state/          ScopeStack, ConstructionState, FunctionState, RetainedPool, RetainedText
ring0/lowering/generics/       TypeBindings, GenericDecls, GenericKinds, InstanceDiscovery
ring0/lowering/lambdas/        FunctionTypes, FunctionTypeDiscovery, LambdaClasses, LambdaCaptures, LambdaTable,
                               LambdaLowerer, SyntheticNodes
ring0/lowering/lists/          ListTable, RefKinds, ListLowerer, ListMembers, ListHigherOrder, ForEachLowerer,
                               TupleTypes, TupleLowerer
ring0/lowering/classes/        tables/ (ClassTable, ClassFields, EnumTable, DispatchTable, InterfaceLinks, MemberResolver),
                               declaration/ (ClassDeclarer, ClassFieldDeclarer, ClassMemberCollector, MutationAnalysis, ScopeUsage, ...),
                               members/ (ConstructorLowerer, ObjectMembers, MemberInvoker, FieldStore, Coercion, ...),
                               dispatch/ (DispatchBuilder, GroupPrototype, VirtualMembers, TypeTestLowerer)
ring0/lowering/functions/      FunctionDeclarer, FunctionLowerer, MethodTable, EntryPoint, ReturnEmitter, ...
ring0/lowering/expressions/    ExpressionLowerer, CallLowerer, GenericCalls, MemberCallLowerer, PrimitiveMembers,
                               TernaryLowerer, OperatorLowerer, LogicalLowerer
ring0/lowering/flow/           StatementLowerer, LocalLowerer, AssignmentLowerer, VariableEnv, control/ (branches, loops)
ring0/lowering/text/           TextLowerer, TextInterpolation, TextHelpers, TextUsage
ring0/lowering/records/        RecordTable, RecordDeclarer, RecordLowerer
ring0/lowering/results/        ResultTypes, ResultLowerer, ResultFlow, ResultStatements, SwitchEmitter, ...
ring0/lowering/values/         FloatBits, DecimalParts, BinaryQuotient, KindResolver, IrNames, UnsupportedReasons
```

## Summary of the integration (state of this lowering)

### Working pipeline

```text
.ev -> Lexer -> Parser -> Binder (types, symbols, null flow)
    -> ring0/lowering: InstanceDiscovery (generic and lambda instances) -> declarations ->
       mutation analysis -> signatures -> dispatch groups -> bodies
    -> Sublang High IR -> .sublang-wire (v2) -> sublang-build.sh --flow=on --optimind=on
    -> LLVM -> native executable (prints main's Int)
```

`scripts/checkLowering.sh` compiles and runs 59 fixtures in one capped sandbox run (6,000,000,000
bytes RAM and RAM+swap, no network, timeouts, one run at a time through a shared lock).

### Supported language features

Int (checked, division toward zero), Bool, Float, static and dynamic String (`+`, `${}`, `==`,
`length()`), locals and assignments, `if`/`while`/`for`/`for-in`/`break`/`continue`, guard
returns, conditional expressions (value kinds), switch over literals/enums/Result, direct calls,
recursion and mutual recursion, records, data classes (primitive fields), exceptions as values,
`Result<T,E>` with `fail`/`success`/`?`/`!`/`orElse`, tuples, lists (value, record and class
elements) with the common operations, generic methods and classes, classes with properties,
constructors, inheritance, abstract members, interfaces and closed-world dispatch, `is`/`as`,
`scoped var`, cascades, enums, lambdas and function values with by-value captures,
`map`/`filter`/`reduce`/`forEach`.

### Remaining blockers, ordered by impact

1. **Output primitive** (item 1): without `io.write_text`, programs cannot print; the only
   observable result is `main`'s Int. Blocks every realistic program.
2. **Shared references** (item 7): objects, lists and closures cannot be aliased in fields, lists,
   closures or returns. Blocks idiomatic object graphs, callbacks that capture objects and
   builder-style code.
3. **Reference fields in records, lists and tuples** (items 2 and 7a): data classes with
   String fields, exception messages, `List<String>`, `Result<String, E>`, tuples with text.
4. **Nullable references** (item 3): properties initialized with `null`, `T?`-free null checks on
   references.
5. **Map layout** and **tasks** (item 7b): dictionaries, `fiber`/`virtual`/`thread`.
6. **Mutable views and scoped virtual results** (item 0): virtual members that write through
   `this`, return text or objects; checked downcast to a class with descendants.
7. **Text and number formatting** (items 5 and 6): `${float}`, character-aware text operations.
8. **Sublang backend defect** (item 9): `emit-llvm` aborts on one reproducible shape of text helper
   calls; tracked by the `backendCrash` fixture.

### Frontend (Ring0 checker) observations

- A tuple literal passed directly to a `List<[A,B]>` method (`pairs.add([1, 2])`) is typed
  `List<Int>` and rejected by the checker ("expected '[Int,Int]', found 'List<Int>'"); the literal
  needs the expected type from the call's parameter.
- The callee name of a function-value call `f(x)` is not annotated with its function type and
  symbol, so a lambda that calls a captured function value cannot be analysed for captures (it is
  diagnosed as shared ownership either way).
- A property named like a class makes the case-insensitive resolution read the property for a
  constructor call (`Engine engine` then `Engine(...)`).
