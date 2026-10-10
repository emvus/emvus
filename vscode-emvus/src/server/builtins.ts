// Builtin types and members. The line tables are copied from the compiler front end
// (Ring0/src/ring0/binding/builtins/BuiltinTypes.ems + BuiltinMembers.ems) so the
// editor knows the same "standard library" the checker does.

export const TYPE_LINES: string[] = [
  // primitives
  'Any', 'Int', 'Float', 'String', 'Boolean', 'Char',
  // collections, Result, tasks
  'List<T>', 'Dictionary<K,V>', 'Result<T,E>', 'Fiber<T>', 'VirtualThread<T>', 'Thread<T>', 'Files',
  // exceptions
  'exception Exception', 'exception IOException : Exception', 'exception UnknownCaseException : Exception',
  // interfaces, function types, opaque types
  'interface Comparable<T>', 'interface Serializable', 'interface IPredicate<T>', 'interface IIterator<T>',
  'interface IList<T>', 'interface ListIterator<T>', 'interface IIterable<T>',
  'variadic Function<A,R>', 'variadic BiFunction<A,B,R>', 'variadic Runnable', 'variadic Tuple',
  'opaque Macro', 'opaque Statement', 'opaque Expression', 'opaque Parameter', 'opaque Method', 'opaque Process',
];

export const MEMBER_LINES: string[] = [
  'Any.equals(dynamic):Boolean', 'Any.hashCode():Int', 'Any.toString():String', 'Exception.message:String',
  'String.length():Int', 'String.isEmpty():Boolean', 'String.isBlank():Boolean', 'String.toLowerCase():String',
  'String.toUpperCase():String', 'String.trim():String', 'String.startsWith(String):Boolean',
  'String.endsWith(String):Boolean', 'String.contains(String):Boolean', 'String.indexOf(String):Int',
  'String.substring(Int,Int):String', 'String.charAt(Int):Char', 'String.replace(String,String):String',
  'String.split(String):List<String>', 'String.repeat(Int):String', 'String.compareTo(String):Int',
  'Char.isDigit():Boolean', 'Char.isLetter():Boolean',
  'Int.abs():Int', 'Int.compareTo(Int):Int', 'static Int.parse(String):Result<Int,?>',
  'Float.abs():Float', 'Float.compareTo(Float):Int', 'static Float.parse(String):Result<Float,?>',
  'List<T>.add(T):Void', 'List<T>.get(Int):T', 'List<T>.set(Int,T):Void', 'List<T>.size():Int',
  'List<T>.length():Int', 'List<T>.isEmpty():Boolean', 'List<T>.contains(T):Boolean', 'List<T>.remove(T):Boolean',
  'List<T>.removeAt(Int):T', 'List<T>.first():T', 'List<T>.last():T', 'List<T>.clear():Void',
  'List<T>.indexOf(T):Int', 'List<T>.map<R>(Function<T,R>):List<R>', 'List<T>.filter(Function<T,Boolean>):List<T>',
  'List<T>.reduce<R>(R,BiFunction<R,T,R>):R', 'List<T>.forEach(Function<T,?>):Void',
  'Dictionary<K,V>.put(K,V):Void', 'Dictionary<K,V>.get(K):V', 'Dictionary<K,V>.contains(K):Boolean',
  'Dictionary<K,V>.containsKey(K):Boolean', 'Dictionary<K,V>.remove(K):V', 'Dictionary<K,V>.size():Int',
  'Dictionary<K,V>.isEmpty():Boolean', 'Dictionary<K,V>.keys():List<K>', 'Dictionary<K,V>.values():List<V>',
  'Dictionary<K,V>.toJson():String', 'Dictionary<K,V>.clear():Void',
  'Result<T,E>.orElse(T):T', 'Result<T,E>.map<R>(Function<T,R>):Result<R,E>',
  'Result<T,E>.mapError<F>(Function<E,F>):Result<T,F>', 'Result<T,E>.isSuccess():Boolean',
  'Result<T,E>.isError():Boolean', 'static Result.success<T>(T):Result<T,?>', 'static Result.error<E>(E):Result<?,E>',
  'Fiber<T>.await():T', 'VirtualThread<T>.await():T', 'Thread<T>.await():T',
  'Comparable<T>.compareTo(T):Int', 'IPredicate<T>.test(T):Boolean',
  'static Files.readText(String):Result<String,?>', 'static Files.open(String):?', 'static Files.exists(String):Boolean',
  'static Files.writeText(String,String):Result<Void,?>',
  'fn println(dynamic):Void', 'fn print(dynamic):Void', 'fn errprintln(dynamic):Void', 'fn panic(String):Void',
];

/** `use std.collections.IList` style paths seen in the language draft (tests/showcase.ev). */
export const STD_PACKAGES: Record<string, string[]> = {
  'std.collections': ['IIterable', 'IIterator', 'IList', 'ListIterator', 'List', 'Dictionary'],
  'std.functional': ['IPredicate', 'Function', 'BiFunction', 'Runnable'],
};

export interface Ty {
  n: string; // base name ('?' = unknown, 'null' = null literal, '[]' = tuple)
  a: Ty[];
}

export const UNKNOWN: Ty = { n: '?', a: [] };
export const NULLTY: Ty = { n: 'null', a: [] };
export const VOID: Ty = { n: 'Void', a: [] };

export function ty(n: string, ...a: Ty[]): Ty {
  return { n, a };
}

export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseTy(s: string): Ty {
  s = s.trim();
  if (!s || s === '?') return UNKNOWN;
  const lt = s.indexOf('<');
  if (lt < 0 || !s.endsWith('>')) return { n: s, a: [] };
  return { n: s.slice(0, lt), a: splitTop(s.slice(lt + 1, -1)).map(parseTy) };
}

export function tyToString(t: Ty): string {
  if (t.n === '[]') return `[${t.a.map(tyToString).join(', ')}]`;
  return t.a.length ? `${t.n}<${t.a.map(tyToString).join(', ')}>` : t.n;
}

export interface BuiltinType {
  name: string;
  kind: 'primitive' | 'class' | 'interface' | 'exception' | 'variadic' | 'opaque';
  generics: string[];
  base?: string;
}

export interface BuiltinMember {
  owner: string;
  name: string;
  isStatic: boolean;
  isField: boolean;
  isFn: boolean;
  generics: string[]; // method level
  params: Ty[];
  ret: Ty;
}

export function parseTypeLine(line: string): BuiltinType {
  let kind: BuiltinType['kind'] = 'class';
  let rest = line;
  for (const k of ['interface', 'exception', 'variadic', 'opaque'] as const) {
    if (rest.startsWith(k + ' ')) { kind = k; rest = rest.slice(k.length + 1); break; }
  }
  let base: string | undefined;
  const colon = rest.indexOf(' : ');
  if (colon >= 0) { base = rest.slice(colon + 3).trim(); rest = rest.slice(0, colon); }
  const m = /^([A-Za-z0-9_]+)(?:<(.*)>)?$/.exec(rest.trim())!;
  const name = m[1];
  if (kind === 'class' && ['Any', 'Int', 'Float', 'String', 'Boolean', 'Char'].includes(name)) kind = 'primitive';
  return { name, kind, generics: m[2] ? m[2].split(',').map(s => s.trim()) : [], base };
}

export function parseMemberLine(line: string): BuiltinMember | null {
  let rest = line;
  if (rest.startsWith('fn ')) {
    const m = /^fn ([A-Za-z0-9_]+)\((.*)\):(.+)$/.exec(rest);
    if (!m) return null;
    return { owner: '', name: m[1], isStatic: true, isField: false, isFn: true, generics: [], params: splitTop(m[2]).map(parseTy), ret: parseTy(m[3]) };
  }
  let isStatic = false;
  if (rest.startsWith('static ')) { isStatic = true; rest = rest.slice(7); }
  // Owner[<T>].name[<R>](P):Ret | Owner.name:Type
  const m = /^([A-Za-z0-9_]+)(?:<([^>]*(?:<[^>]*>)?[^>]*)>)?\.([A-Za-z0-9_]+)(?:<([^>]*)>)?(?:\((.*)\))?:(.+)$/.exec(rest);
  if (!m) return null;
  return {
    owner: m[1], name: m[3], isStatic, isField: m[5] === undefined, isFn: false,
    generics: m[4] ? m[4].split(',').map(s => s.trim()) : [],
    params: m[5] !== undefined && m[5] !== '' ? splitTop(m[5]).map(parseTy) : [],
    ret: parseTy(m[6]),
  };
}

export const BUILTIN_TYPES: BuiltinType[] = TYPE_LINES.map(parseTypeLine);
export const BUILTIN_MEMBERS: BuiltinMember[] = MEMBER_LINES.map(parseMemberLine).filter((m): m is BuiltinMember => !!m);
