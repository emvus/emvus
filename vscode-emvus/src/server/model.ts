// Declaration model derived from the AST + the project-wide index.
import { Node, child, childrenOf } from './ast';
import { BUILTIN_MEMBERS, BUILTIN_TYPES, STD_PACKAGES, Ty, UNKNOWN, parseTy } from './builtins';
import { ParseResult, parse } from './parser';

export interface ParamDecl {
  name: string;
  ty: Ty;
  hasDefault: boolean;
  node: Node | null;
}

export interface MemberDecl {
  name: string;
  kind: 'property' | 'field' | 'method' | 'constructor' | 'enum-entry' | 'variable';
  node: Node | null;
  owner: TypeDecl | null;
  ty: Ty; // property/field type or method return type (Void when omitted)
  params: ParamDecl[];
  generics: string[];
  isStatic: boolean;
  isAbstract: boolean;
  isPrivate: boolean;
  isProtected: boolean;
  isOverride: boolean;
  isFinal: boolean;
  accessors: string[]; // ['get','set','private set']
  hasInit: boolean;
  nullInit: boolean;
  hasBody: boolean;
  annotations: string[];
  placeholder: boolean;
}

export type TypeKind = 'class' | 'data-class' | 'record' | 'interface' | 'exception' | 'enum' | 'builtin';

export interface TypeDecl {
  name: string;
  kind: TypeKind;
  builtinKind?: string;
  node: Node | null;
  file: FileModel | null;
  pkg: string;
  generics: string[];
  based: Ty[];
  implements: Ty[];
  params: ParamDecl[]; // data class / record / exception parameters
  members: MemberDecl[];
  isAbstract: boolean;
  annotations: string[];
}

export interface UseEntry {
  path: string; // dotted
  alias: string;
  node: Node;
}

export interface MacroDecl {
  name: string;
  params: ParamDecl[];
  targets: string[];
  node: Node;
}

export interface FileModel {
  uri: string;
  text: string;
  parse: ParseResult;
  pkg: string;
  pkgNode: Node | null;
  uses: UseEntry[];
  useNodes: Node[];
  types: TypeDecl[];
  methods: MemberDecl[]; // top-level methods
  variables: MemberDecl[]; // top-level var
  macros: MacroDecl[];
}

export const lc = (s: string) => s.toLowerCase();

export function tyFromNode(n: Node | undefined): Ty {
  if (!n) return UNKNOWN;
  if (n.kind === 'tuple-type') return { n: '[]', a: n.children.map(tyFromNode) };
  if (n.kind === 'type' || n.kind === 'return-type') {
    if (n.text === '?' || n.text === '') return UNKNOWN;
    return { n: n.text, a: n.children.filter(c => c.kind === 'type' || c.kind === 'tuple-type').map(tyFromNode) };
  }
  return UNKNOWN;
}

function modsOf(n: Node): Set<string> {
  const m = child(n, 'modifiers');
  return new Set((m?.children ?? []).map(c => c.text));
}

function annotationsOf(n: Node): string[] {
  return childrenOf(n, 'annotation').map(a => a.text);
}

function paramsOf(n: Node | undefined): ParamDecl[] {
  if (!n) return [];
  return childrenOf(n, 'param').map(p => {
    const typeNode = p.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
    const idx = typeNode ? p.children.indexOf(typeNode) : -1;
    const hasDefault = idx >= 0 && p.children.slice(idx + 1).some(c => c.kind !== 'annotation' && c.kind !== 'modifiers');
    return { name: p.text, ty: tyFromNode(typeNode), hasDefault, node: p };
  });
}

function whereGenerics(n: Node): string[] {
  const w = child(n, 'where');
  return (w?.children ?? []).filter(c => c.kind === 'typeparam').map(c => c.text);
}

function makeMember(n: Node, owner: TypeDecl | null): MemberDecl | null {
  const mods = modsOf(n);
  const base = {
    name: n.text, node: n, owner, params: [] as ParamDecl[], generics: whereGenerics(n),
    isStatic: mods.has('static'), isAbstract: mods.has('abstract'), isPrivate: mods.has('private'),
    isProtected: mods.has('protected'), isOverride: mods.has('override'), isFinal: mods.has('final'),
    accessors: [] as string[], hasInit: false, nullInit: false, hasBody: false,
    annotations: annotationsOf(n), placeholder: false,
  };
  switch (n.kind) {
    case 'method': {
      const body = child(n, 'block');
      const rt = child(n, 'return-type');
      return {
        ...base, kind: 'method', ty: rt ? tyFromNode(rt) : { n: 'Void', a: [] },
        params: paramsOf(child(n, 'params')), hasBody: !!body,
        placeholder: !!body && body.children.length === 1 && body.children[0].kind === 'placeholder',
      };
    }
    case 'constructor':
      return { ...base, kind: 'constructor', ty: { n: owner?.name ?? '', a: [] }, params: paramsOf(child(n, 'params')), hasBody: true };
    case 'property':
    case 'field':
    case 'variable': {
      const typeNode = n.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
      const idx = typeNode ? n.children.indexOf(typeNode) : -1;
      const init = n.children.slice(idx + 1).find(c => c.kind !== 'accessors');
      const acc = child(n, 'accessors');
      return {
        ...base, kind: n.kind as 'property' | 'field' | 'variable',
        ty: typeNode && typeNode.text === 'var' ? UNKNOWN : tyFromNode(typeNode),
        accessors: (acc?.children ?? []).map(a => a.text), hasInit: !!init, nullInit: init?.kind === 'null-literal',
      };
    }
    default:
      return null;
  }
}

function makeType(n: Node, file: FileModel): TypeDecl {
  const kind = n.kind as TypeKind;
  const mods = modsOf(n);
  const t: TypeDecl = {
    name: n.text, kind, node: n, file, pkg: file.pkg, generics: whereGenerics(n), based: [], implements: [],
    params: [], members: [], isAbstract: mods.has('abstract') || kind === 'interface', annotations: annotationsOf(n),
  };
  const basedNode = child(n, 'based');
  if (basedNode) t.based = basedNode.children.map(tyFromNode);
  const implNode = child(n, 'implements');
  if (implNode) t.implements = implNode.children.map(tyFromNode);
  if (kind === 'data-class' || kind === 'record' || kind === 'exception') {
    t.params = paramsOf(child(n, 'params'));
    // the primary parameters are read-only properties
    for (const p of t.params) {
      t.members.push({
        name: p.name, kind: 'property', node: p.node, owner: t, ty: p.ty, params: [], generics: [], isStatic: false,
        isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: ['get'],
        hasInit: false, nullInit: false, hasBody: false, annotations: [], placeholder: false,
      });
    }
  }
  const body = child(n, 'body');
  if (kind === 'data-class' || kind === 'record') {
    // generated: copy, withX per field; equals/hashCode/toString come from Any
    const gen = (name: string, params: ParamDecl[]): MemberDecl => ({
      name, kind: 'method', node: null, owner: t, ty: { n: t.name, a: [] }, params, generics: [], isStatic: false,
      isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: [],
      hasInit: false, nullInit: false, hasBody: true, annotations: [], placeholder: false,
    });
    t.members.push(gen('copy', []));
    for (const p of t.params) {
      t.members.push(gen('with' + p.name.charAt(0).toUpperCase() + p.name.slice(1), [{ name: p.name, ty: p.ty, hasDefault: false, node: null }]));
    }
  }
  for (const m of body?.children ?? []) {
    if (m.kind === 'enum-entry') {
      t.members.push({
        name: m.text, kind: 'enum-entry', node: m, owner: t, ty: { n: t.name, a: [] }, params: [], generics: [],
        isStatic: true, isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: true,
        accessors: ['get'], hasInit: false, nullInit: false, hasBody: false, annotations: [], placeholder: false,
      });
      continue;
    }
    const md = makeMember(m, t);
    if (md) t.members.push(md);
  }
  return t;
}

export function buildFile(uri: string, text: string): FileModel {
  const pr = parse(text);
  const file: FileModel = {
    uri, text, parse: pr, pkg: '', pkgNode: null, uses: [], useNodes: [], types: [], methods: [], variables: [], macros: [],
  };
  for (const n of pr.root.children) {
    switch (n.kind) {
      case 'package': file.pkg = n.text; file.pkgNode = n; break;
      case 'use':
        file.useNodes.push(n);
        for (const it of n.children) {
          if (it.kind !== 'use-item') continue;
          file.uses.push({ path: it.text, alias: child(it, 'alias')?.text ?? '', node: it });
        }
        break;
      case 'class': case 'data-class': case 'record': case 'interface': case 'exception': case 'enum':
        file.types.push(makeType(n, file));
        break;
      case 'macro':
        file.macros.push({
          name: n.text, params: paramsOf(child(n, 'params')),
          targets: (child(n, 'targets')?.children ?? []).map(t => t.text), node: n,
        });
        break;
      case 'method': {
        const m = makeMember(n, null);
        if (m) file.methods.push(m);
        break;
      }
      case 'variable': {
        const m = makeMember(n, null);
        if (m) file.variables.push(m);
        break;
      }
      default: break;
    }
  }
  return file;
}

// ---------------------------------------------------------------------------
// Project index
// ---------------------------------------------------------------------------

export class Project {
  files = new Map<string, FileModel>();
  builtins = new Map<string, TypeDecl>();
  private byPkg = new Map<string, Map<string, TypeDecl[]>>();
  private dirty = true;

  constructor() {
    for (const b of BUILTIN_TYPES) {
      const t: TypeDecl = {
        name: b.name, kind: 'builtin', builtinKind: b.kind, node: null, file: null, pkg: '', generics: b.generics,
        based: b.base ? [parseTy(b.base)] : [], implements: [], params: [], members: [], isAbstract: b.kind === 'interface',
        annotations: [],
      };
      this.builtins.set(lc(b.name), t);
    }
    for (const bm of BUILTIN_MEMBERS) {
      if (bm.isFn) continue;
      const owner = this.builtins.get(lc(bm.owner));
      if (!owner) continue;
      owner.members.push({
        name: bm.name, kind: bm.isField ? 'field' : 'method', node: null, owner, ty: bm.ret,
        params: bm.params.map((p, i) => ({ name: `arg${i + 1}`, ty: p, hasDefault: false, node: null })),
        generics: bm.generics, isStatic: bm.isStatic, isAbstract: false, isPrivate: false, isProtected: false,
        isOverride: false, isFinal: false, accessors: bm.isField ? ['get'] : [], hasInit: false, nullInit: false,
        hasBody: true, annotations: [], placeholder: false,
      });
    }
  }

  setFile(uri: string, text: string): FileModel {
    const f = buildFile(uri, text);
    this.files.set(uri, f);
    this.dirty = true;
    return f;
  }
  removeFile(uri: string) { this.files.delete(uri); this.dirty = true; }

  private rebuild() {
    if (!this.dirty) return;
    this.dirty = false;
    this.byPkg.clear();
    for (const f of this.files.values()) {
      let m = this.byPkg.get(f.pkg);
      if (!m) { m = new Map(); this.byPkg.set(f.pkg, m); }
      for (const t of f.types) {
        const k = lc(t.name);
        const a = m.get(k);
        if (a) a.push(t); else m.set(k, [t]);
      }
    }
  }

  packages(): string[] { this.rebuild(); return [...this.byPkg.keys()]; }
  typesInPackage(pkg: string): TypeDecl[] {
    this.rebuild();
    return [...(this.byPkg.get(pkg)?.values() ?? [])].flat();
  }
  allTypes(): TypeDecl[] {
    this.rebuild();
    return [...this.byPkg.values()].flatMap(m => [...m.values()].flat());
  }
  findInPackage(pkg: string, name: string): TypeDecl | undefined {
    this.rebuild();
    return this.byPkg.get(pkg)?.get(lc(name))?.[0];
  }
  packageKnown(pkg: string): boolean {
    this.rebuild();
    return this.byPkg.has(pkg) || !!STD_PACKAGES[pkg];
  }
  /** top-level methods in the same package (project wide) */
  topLevelMethods(file: FileModel, name: string): MemberDecl[] {
    const out: MemberDecl[] = [];
    for (const f of this.files.values()) {
      if (f.pkg !== file.pkg) continue;
      for (const m of f.methods) if (lc(m.name) === lc(name)) out.push(m);
    }
    return out;
  }
  topLevelVariable(file: FileModel, name: string): MemberDecl | undefined {
    for (const f of this.files.values()) {
      if (f.pkg !== file.pkg) continue;
      const v = f.variables.find(x => lc(x.name) === lc(name));
      if (v) return v;
    }
    return undefined;
  }

  /** Resolve a type name as seen from `file`. */
  resolve(file: FileModel | null, name: string): TypeDecl | undefined {
    this.rebuild();
    const key = lc(name);
    if (file) {
      // alias or imported name
      for (const u of file.uses) {
        if (u.alias) {
          if (lc(u.alias) === key) return this.byPath(u.path);
          continue;
        }
        const last = u.path.split('.').pop()!;
        if (lc(last) === key) {
          const t = this.byPath(u.path);
          if (t) return t;
        }
        // package import: use util.playermanager makes its types visible
        const inPkg = this.byPkg.get(u.path)?.get(key)?.[0];
        if (inPkg) return inPkg;
      }
      // same package (case-insensitive)
      const own = this.byPkg.get(file.pkg)?.get(key)?.[0];
      if (own) return own;
    }
    if (name.includes('.')) return this.byPath(name);
    return this.builtins.get(key);
  }

  byPath(path: string): TypeDecl | undefined {
    const i = path.lastIndexOf('.');
    if (i < 0) return this.builtins.get(lc(path));
    const pkg = path.slice(0, i);
    const name = path.slice(i + 1);
    const t = this.byPkg.get(pkg)?.get(lc(name))?.[0];
    if (t) return t;
    if (STD_PACKAGES[pkg]?.some(x => lc(x) === lc(name))) return this.builtins.get(lc(name));
    return undefined;
  }

  /** Own + inherited members (breadth first through based/implements). */
  allMembers(t: TypeDecl, seen = new Set<TypeDecl>()): MemberDecl[] {
    if (seen.has(t)) return [];
    seen.add(t);
    const out = [...t.members];
    for (const s of this.supers(t)) {
      const d = this.resolve(t.file, s.n);
      if (d) out.push(...this.allMembers(d, seen));
    }
    if (t.kind !== 'builtin') {
      const any = this.builtins.get('any');
      if (any && !seen.has(any)) out.push(...any.members);
    }
    return out;
  }

  /** Direct supertypes (based + implements) of a type. */
  supers(t: TypeDecl): Ty[] {
    const out = [...t.based, ...t.implements];
    if (t.kind === 'exception' && !t.based.length) out.push({ n: 'Exception', a: [] });
    return out;
  }
}
