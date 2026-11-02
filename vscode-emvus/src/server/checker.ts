// Binding + flow checks for Emvus. One abstract interpreter evaluates each method body:
// it types expressions, resolves names and tracks null-state through control flow.
// Messages are chosen to match the expectations in Ring0/tests/{binding,flow}/*.ev.
import { Node, child, childrenOf } from './ast';
import { NULLTY, STD_PACKAGES, Ty, UNKNOWN, VOID, tyToString } from './builtins';
import { FileModel, MemberDecl, Project, TypeDecl, lc, tyFromNode } from './model';

export interface Finding {
  start: number;
  end: number;
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning' | 'hint';
  code?: string;
  data?: Record<string, unknown>;
  unnecessary?: boolean;
}

type NN = 'non' | 'maybe' | 'null';
const joinNN = (a: NN, b: NN): NN => (a === b ? a : 'maybe');

interface VarInfo {
  name: string;
  ty: Ty;
  nn: NN;
  kind: 'param' | 'local' | 'binding' | 'lambda' | 'foreach';
  final: boolean;
  node: Node | null;
}

class Env {
  vars = new Map<string, VarInfo>();
  assigned = new Set<string>();
  clone(): Env {
    const e = new Env();
    for (const [k, v] of this.vars) e.vars.set(k, v);
    e.assigned = new Set(this.assigned);
    return e;
  }
}

function joinEnv(a: Env | null, b: Env | null): Env | null {
  if (!a) return b;
  if (!b) return a;
  const r = a.clone();
  for (const [k, bv] of b.vars) {
    const av = r.vars.get(k);
    if (av) r.vars.set(k, { ...av, nn: joinNN(av.nn, bv.nn) });
  }
  r.assigned = new Set([...a.assigned].filter(x => b.assigned.has(x)));
  return r;
}

interface Val {
  ty: Ty;
  nn: NN;
  typeRef?: TypeDecl; // the expression names a type
  path?: string; // textual path for diagnostics (`profile.nickname`)
  prop?: MemberDecl; // the value is a property read
  name?: string; // plain variable
}

const PRIMS = new Set(['int', 'float', 'string', 'boolean', 'char']);
const GLOBAL_FNS = new Set(['println', 'print', 'errprintln', 'panic']);
const isUnknown = (t: Ty) => t.n === '?' || t.n === '' || t.n === 'var';
const isResult = (t: Ty) => lc(t.n) === 'result';
const val = (ty: Ty, nn: NN = 'non'): Val => ({ ty, nn });
const UNK: Val = { ty: UNKNOWN, nn: 'non' };

export interface Res {
  typeRef?: TypeDecl;
  member?: MemberDecl;
  varDecl?: Node | null;
  varName?: string;
  ty?: Ty;
}

export interface Analysis {
  findings: Finding[];
  types: Map<Node, Ty>; // static type of every evaluated expression node
  res: Map<Node, Res>; // resolution of name / member / call-callee nodes
}

export function checkFile(project: Project, file: FileModel): Finding[] {
  return new FileChecker(project, file).run();
}

export function analyzeFile(project: Project, file: FileModel): Analysis {
  const c = new FileChecker(project, file);
  c.collect = true;
  const findings = c.run();
  return { findings, types: c.typeMap, res: c.resMap };
}

class FileChecker {
  collect = false;
  typeMap = new Map<Node, Ty>();
  resMap = new Map<Node, Res>();
  out: Finding[] = [];
  private seen = new Set<string>();
  private silent = 0;
  private cls: TypeDecl | null = null;
  private method: MemberDecl | null = null;
  private inCtor = false;
  private typeParams = new Set<string>();
  private retTy: Ty = VOID;
  private inLambda = 0;
  private inMacro = false;
  private taskReturns: Ty[][] = [];
  private macroNames = new Set<string>();

  constructor(private p: Project, private f: FileModel) {
    for (const ff of p.files.values()) for (const m of ff.macros) this.macroNames.add(lc(m.name));
  }

  // ---- reporting ----------------------------------------------------------
  private report(n: { start: number; end: number; line: number; col: number }, message: string, opts: Partial<Finding> = {}) {
    if (this.silent) return;
    const key = `${n.start}:${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push({ start: n.start, end: Math.max(n.end, n.start + 1), line: n.line, col: n.col, message, severity: 'error', ...opts });
  }
  private reportName(n: Node, message: string, opts: Partial<Finding> = {}) {
    const s = n.nameStart ?? n.start;
    const e = n.nameEnd ?? n.end;
    this.report({ start: s, end: e, line: n.line, col: n.col }, message, opts);
  }

  // ---- entry --------------------------------------------------------------
  run(): Finding[] {
    const f = this.f;
    this.checkImports();
    this.checkDuplicateTypes();
    for (const t of f.types) this.checkType(t);
    for (const m of f.methods) this.checkMethod(m, null);
    for (const v of f.variables) this.checkFieldInit(v, null);
    for (const mac of f.macros) this.checkMacro(mac.node);
    return this.out;
  }

  // ---- imports ------------------------------------------------------------
  private checkImports() {
    const seen = new Map<string, Node>();
    for (const u of this.f.uses) {
      const key = lc(u.alias || u.path);
      if (seen.has(key)) this.report(u.node, `Duplicate import '${u.path}'`, { severity: 'warning', code: 'duplicate-use', unnecessary: true });
      seen.set(key, u.node);
      const resolved = this.p.byPath(u.path) || this.p.packageKnown(u.path);
      if (resolved) continue;
      const root = u.path.split('.')[0];
      const rootKnown = this.p.packages().some(k => k === root || k.startsWith(root + '.')) || root === 'std';
      if (rootKnown) {
        const i = u.path.lastIndexOf('.');
        const pkg = i >= 0 ? u.path.slice(0, i) : '';
        const hint = STD_PACKAGES[pkg] ? ` (known in ${pkg}: ${STD_PACKAGES[pkg].join(', ')})` : '';
        this.report(
          { start: u.node.nameStart ?? u.node.start, end: u.node.nameEnd ?? u.node.end, line: u.node.line, col: u.node.col },
          `Cannot resolve import '${u.path}'${hint}`, { severity: 'warning', code: 'unresolved-use' },
        );
      }
    }
  }

  private checkDuplicateTypes() {
    for (const t of this.f.types) {
      if (!t.node) continue;
      for (const other of this.p.typesInPackage(this.f.pkg)) {
        if (other === t || lc(other.name) !== lc(t.name)) continue;
        const earlier = other.file === this.f
          ? (other.node!.start < t.node.start)
          : (other.file!.uri < this.f.uri);
        if (earlier) {
          this.reportName(t.node, `Duplicate declaration of '${t.name}'`, { code: 'duplicate-declaration' });
          break;
        }
      }
    }
  }

  // ---- types in declarations ---------------------------------------------
  private typeKnown(name: string): boolean {
    if (!name || name === '?' || name === 'var' || name === 'dynamic') return true;
    if (this.typeParams.has(name)) return true;
    if (this.p.resolve(this.f, name)) return true;
    if (lc(name) === 'tuple' || lc(name) === 'void') return true;
    // qualified through an alias or package that cannot be resolved here
    if (name.includes('.')) {
      const root = name.split('.')[0];
      if (!this.p.packages().some(k => k === root || k.startsWith(root + '.'))) return true;
    }
    return false;
  }

  private checkTypeNode(n: Node | undefined) {
    if (!n) return;
    if (n.kind === 'type' && !this.typeKnown(n.text)) {
      this.report(
        { start: n.nameStart ?? n.start, end: n.nameEnd ?? n.end, line: n.line, col: n.col },
        `Unknown type '${n.text}'`, { code: 'unknown-type', data: { name: n.text } },
      );
    }
    for (const c of n.children) if (c.kind === 'type' || c.kind === 'tuple-type') this.checkTypeNode(c);
  }

  private checkParamTypes(params: Node | undefined) {
    if (!params) return;
    for (const prm of params.children) {
      const t = prm.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
      this.checkTypeNode(t);
      for (const a of childrenOf(prm, 'annotation')) void a;
    }
  }

  private checkDefaultOrder(params: Node | undefined) {
    if (!params) return;
    let seenDefault = false;
    for (const prm of childrenOf(params, 'param')) {
      const t = prm.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
      const idx = t ? prm.children.indexOf(t) : -1;
      const has = idx >= 0 && prm.children.slice(idx + 1).some(c => c.kind !== 'annotation' && c.kind !== 'modifiers');
      if (has) seenDefault = true;
      else if (seenDefault) {
        this.reportName(prm, `Parameter '${prm.text}' without default value cannot follow a parameter with a default value`, { code: 'default-order' });
      }
    }
  }

  // ---- types --------------------------------------------------------------
  private checkType(t: TypeDecl) {
    const n = t.node!;
    this.cls = t;
    this.typeParams = new Set(t.generics);
    const params = child(n, 'params');
    this.checkParamTypes(params);
    this.checkDefaultOrder(params);
    for (const k of ['based', 'implements']) {
      const list = child(n, k);
      for (const tn of list?.children ?? []) this.checkTypeNode(tn);
    }
    const w = child(n, 'where');
    for (const tp of w?.children ?? []) for (const b of tp.children) this.checkTypeNode(b);

    // implements / based sanity
    const implNode = child(n, 'implements');
    for (const tn of implNode?.children ?? []) {
      const d = this.p.resolve(this.f, tn.text);
      if (d && d.kind !== 'interface' && !(d.kind === 'builtin' && d.builtinKind === 'interface')) {
        this.report(
          { start: tn.start, end: tn.end, line: tn.line, col: tn.col },
          `Class '${t.name}' cannot implement class '${d.name}'; use 'based' for inheritance`, { code: 'implements-class' },
        );
      }
    }
    if (t.kind === 'class' || t.kind === 'data-class') {
      for (const tn of child(n, 'based')?.children ?? []) {
        const d = this.p.resolve(this.f, tn.text);
        if (d && (d.kind === 'interface')) {
          this.report(
            { start: tn.start, end: tn.end, line: tn.line, col: tn.col },
            `Class '${t.name}' cannot be based on interface '${d.name}'; use 'implements'`, { code: 'based-interface' },
          );
        }
      }
    }

    // duplicate members
    const seen = new Map<string, MemberDecl>();
    for (const m of t.members) {
      if (m.kind === 'method' || m.kind === 'constructor' || !m.node) continue;
      const k = lc(m.name);
      if (seen.has(k) && seen.get(k)!.node !== m.node) this.reportName(m.node, `Duplicate declaration of '${m.name}'`, { code: 'duplicate-declaration' });
      seen.set(k, m);
    }

    this.checkAbstract(t);

    // member bodies
    for (const m of t.members) {
      if (!m.node) continue;
      if (m.kind === 'method' || m.kind === 'constructor') this.checkMethod(m, t);
      else if (m.kind === 'property' || m.kind === 'field') {
        this.checkTypeNode(m.node.children.find(c => c.kind === 'type' || c.kind === 'tuple-type'));
        this.checkFieldInit(m, t);
      } else if (m.kind === 'enum-entry') {
        const env = new Env();
        for (const a of m.node.children) this.evalExpr(a, env);
      }
    }
    this.checkCtorInit(t);
    this.cls = null;
    this.typeParams = new Set();
  }

  /** members of `t` + inherited ones (name -> declarations) */
  private allMembers(t: TypeDecl, seen = new Set<TypeDecl>()): MemberDecl[] {
    if (seen.has(t)) return [];
    seen.add(t);
    const out = [...t.members];
    for (const s of this.p.supers(t)) {
      const d = this.p.resolve(t.file ?? this.f, s.n);
      if (d) out.push(...this.allMembers(d, seen));
    }
    return out;
  }

  private checkAbstract(t: TypeDecl) {
    if (t.isAbstract || t.kind === 'interface' || t.kind === 'builtin') return;
    const all = this.allMembers(t);
    const concrete = all.filter(m => m.kind === 'method' && (m.hasBody || (m.owner && m.owner.kind !== 'interface' && !m.isAbstract)));
    const reported = new Set<string>();
    for (const m of all) {
      if (m.kind !== 'method') continue;
      const abstract = m.isAbstract || (!m.hasBody && m.owner?.kind === 'interface');
      if (!abstract || m.owner?.kind === 'builtin') continue;
      const impl = concrete.some(c => lc(c.name) === lc(m.name) && c.params.length === m.params.length && c !== m);
      const key = lc(m.name) + '/' + m.params.length;
      if (!impl && !reported.has(key) && t.node) {
        reported.add(key);
        this.reportName(t.node, `Class '${t.name}' does not implement abstract method '${m.name}'`, { code: 'abstract-not-implemented' });
      }
    }
  }

  private checkFieldInit(m: MemberDecl, t: TypeDecl | null) {
    if (!m.node) return;
    const typeNode = m.node.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
    if (t === null) this.checkTypeNode(typeNode);
    const idx = typeNode ? m.node.children.indexOf(typeNode) : -1;
    const init = m.node.children.slice(idx + 1).find(c => c.kind !== 'accessors' && c.kind !== 'modifiers' && c.kind !== 'annotation');
    if (!init) return;
    const env = new Env();
    const v = this.evalExpr(init, env);
    if (typeNode && typeNode.text !== 'var' && this.incompatible(v.ty, m.ty)) {
      this.reportName(m.node, `Initializer of '${m.name}': expected '${tyToString(m.ty)}', found '${tyToString(v.ty)}'`, { code: 'type-mismatch' });
    }
  }

  // ---- constructors: definite initialization -----------------------------
  private ctorEnvs: Env[] = [];
  private checkCtorInit(t: TypeDecl) {
    const ctors = t.members.filter(m => m.kind === 'constructor');
    if (!ctors.length) return;
    const props = t.members.filter(m => m.kind === 'property' && !m.hasInit && m.node && t.kind === 'class');
    for (const c of ctors) {
      const end = this.ctorResults.get(c);
      if (!end || !c.node) continue;
      for (const p of props) {
        if (!end.has(lc(p.name))) {
          this.reportName(c.node, `Property '${p.name}' may not be initialized on every path through this constructor`, { code: 'uninitialized-property' });
        }
      }
    }
  }
  private ctorResults = new Map<MemberDecl, Set<string>>();

  // ---- methods ------------------------------------------------------------
  private checkMethod(m: MemberDecl, owner: TypeDecl | null) {
    const n = m.node;
    if (!n) return;
    const prevGen = this.typeParams;
    this.typeParams = new Set([...prevGen, ...m.generics]);
    this.method = m;
    this.inCtor = m.kind === 'constructor';
    const rt = child(n, 'return-type');
    if (rt) this.checkTypeNode(rt);
    const params = child(n, 'params');
    this.checkParamTypes(params);
    this.checkDefaultOrder(params);
    for (const tp of child(n, 'where')?.children ?? []) for (const b of tp.children) this.checkTypeNode(b);
    const annotated = m.annotations.length > 0;
    this.retTy = annotated ? UNKNOWN : m.ty;

    const env = new Env();
    for (const prm of m.params) {
      const pn = prm.node;
      if (!pn) continue;
      if (env.vars.has(lc(prm.name))) this.reportName(pn, `Duplicate declaration of '${prm.name}'`, { code: 'duplicate-declaration' });
      env.vars.set(lc(prm.name), { name: prm.name, ty: prm.ty, nn: 'non', kind: 'param', final: false, node: pn });
      const dflt = pn.children.slice(pn.children.findIndex(c => c.kind === 'type' || c.kind === 'tuple-type') + 1)
        .find(c => c.kind !== 'annotation' && c.kind !== 'modifiers');
      if (dflt) this.evalExpr(dflt, env);
    }
    const sc = child(n, 'super-call');
    if (sc) for (const a of sc.children) this.evalExpr(a, env);

    const body = child(n, 'block');
    if (body && !m.placeholder) {
      const end = this.execBlock(body, env, true);
      if (m.kind === 'constructor' && end) this.ctorResults.set(m, end.assigned);
      else if (m.kind === 'constructor') this.ctorResults.set(m, new Set(owner?.members.map(x => lc(x.name)) ?? []));
    } else if (m.kind === 'constructor') this.ctorResults.set(m, new Set());

    this.method = null;
    this.inCtor = false;
    this.typeParams = prevGen;
  }

  private checkMacro(n: Node) {
    this.inMacro = true;
    this.method = null;
    const env = new Env();
    env.vars.set('target', { name: 'target', ty: UNKNOWN, nn: 'non', kind: 'param', final: true, node: null });
    const params = child(n, 'params');
    this.checkParamTypes(params);
    this.checkDefaultOrder(params);
    for (const prm of childrenOf(params ?? n, 'param')) {
      const tn = prm.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
      env.vars.set(lc(prm.text), { name: prm.text, ty: tyFromNode(tn), nn: 'non', kind: 'param', final: false, node: prm });
    }
    this.retTy = UNKNOWN;
    const body = child(n, 'block');
    if (body) this.execBlock(body, env, true);
    this.inMacro = false;
  }

  // ---- statements ---------------------------------------------------------
  /** Executes a block; returns the end environment (null when unreachable). */
  private execBlock(block: Node, env0: Env, isMethodBody = false): Env | null {
    let env: Env | null = env0.clone();
    const declared: string[] = [];
    for (const s of block.children) {
      if (!env) break; // unreachable code is not analysed
      env = this.execStmt(s, env, declared);
    }
    if (env && !isMethodBody) for (const d of declared) env.vars.delete(d);
    return env;
  }

  private declare(env: Env, v: VarInfo, declared: string[] | null, at: Node) {
    const k = lc(v.name);
    if (v.name !== '_' && env.vars.has(k) && env.vars.get(k)!.kind !== 'lambda') {
      this.reportName(at, `Duplicate declaration of '${v.name}'`, { code: 'duplicate-declaration' });
    }
    env.vars.set(k, v);
    declared?.push(k);
  }

  private execStmt(s: Node, env: Env, declared: string[]): Env | null {
    switch (s.kind) {
      case 'block': return this.execBlock(s, env);
      case 'placeholder': return env;
      case 'local': {
        const typeNode = s.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
        const isVar = !typeNode || typeNode.text === 'var' || typeNode.text === 'dynamic';
        if (typeNode && !isVar) this.checkTypeNode(typeNode);
        const init = s.children[s.children.length - 1];
        const hasInit = init !== typeNode && init.kind !== 'modifiers' && init.kind !== 'modifier' && s.children.indexOf(init) > s.children.indexOf(typeNode!);
        let v: Val = UNK;
        if (hasInit) v = this.evalExpr(init, env);
        const declTy = isVar || !typeNode ? (typeNode?.text === 'dynamic' ? UNKNOWN : v.ty) : tyFromNode(typeNode);
        if (hasInit && !isVar && this.incompatible(v.ty, declTy)) {
          this.reportName(s, `Initializer of '${s.text}': expected '${tyToString(declTy)}', found '${tyToString(v.ty)}'`, { code: 'type-mismatch' });
        }
        const final = s.children.some(c => c.kind === 'modifier' && c.text === 'final');
        this.declare(env, { name: s.text, ty: declTy, nn: hasInit ? v.nn : 'non', kind: 'local', final, node: s }, declared, s);
        return env;
      }
      case 'destructure': {
        const init = s.children[s.children.length - 1];
        const v = this.evalExpr(init, env);
        const elems = this.destructureTypes(v.ty);
        let i = 0;
        for (const b of s.children) {
          if (b.kind === 'binding') this.declare(env, { name: b.text, ty: elems[i] ?? UNKNOWN, nn: 'non', kind: 'binding', final: false, node: b }, declared, b);
          if (b.kind === 'binding' || b.kind === 'wildcard') i++;
        }
        return env;
      }
      case 'expr-stmt': {
        const e = s.children[0];
        const v = this.evalExpr(e, env);
        if (isResult(v.ty) && (e.kind === 'call' || e.kind === 'cascade')) {
          this.report(e, 'Result is ignored: handle it with switch, ?, ! or assign it', { code: 'ignored-result' });
        }
        return env;
      }
      case 'if': {
        const cond = s.children[0];
        this.evalExpr(cond, env);
        const thenEnv = this.refine(cond, env, true);
        const elseEnv = this.refine(cond, env, false);
        const out = this.execBlock(s.children[1], thenEnv);
        const el = s.children[2];
        if (el && el.kind === 'else') {
          const e2 = this.execStmt(el.children[0], elseEnv, []);
          return joinEnv(out, e2);
        }
        return joinEnv(out, elseEnv);
      }
      case 'while': return this.loop(env, s.children[0], null, s.children[1]);
      case 'for': {
        const [init, cond, upd, body] = s.children;
        const e: Env = env.clone();
        const dec: string[] = [];
        for (const i of init.children) {
          if (i.kind === 'local') this.execStmt(i, e, dec);
          else this.evalExpr(i, e);
        }
        const r = this.loop(e, cond.children[0] ?? null, upd, body);
        if (r) for (const d of dec) r.vars.delete(d);
        return r ?? e;
      }
      case 'foreach': {
        const iterable = s.children[s.children.length - 2];
        const body = s.children[s.children.length - 1];
        const typeNode = s.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
        if (typeNode && typeNode.text !== 'var') this.checkTypeNode(typeNode);
        const it = this.evalExpr(iterable, env);
        this.derefCheck(iterable, it);
        const e = env.clone();
        let elemTy = UNKNOWN;
        if (typeNode && typeNode.text !== 'var') elemTy = tyFromNode(typeNode);
        else if (lc(it.ty.n) === 'list') elemTy = it.ty.a[0] ?? UNKNOWN;
        this.declare(e, { name: s.text, ty: elemTy, nn: 'non', kind: 'foreach', final: false, node: s }, null, s);
        this.silent++;
        const o1 = this.execBlock(body, e);
        this.silent--;
        const header = joinEnv(e, o1) ?? e;
        header.vars.set(lc(s.text), { name: s.text, ty: elemTy, nn: 'non', kind: 'foreach', final: false, node: s });
        this.execBlock(body, header);
        return env;
      }
      case 'return': {
        const e = s.children[0];
        if (e) {
          const v = this.evalExpr(e, env);
          this.checkReturn(e, v, env);
        }
        if (this.inLambda) { this.taskReturns[this.taskReturns.length - 1]?.push(e ? this.evalSilent(e, env).ty : VOID); }
        return this.inLambda ? env : null;
      }
      case 'fail': {
        const e = s.children[0];
        const v = this.evalExpr(e, env);
        this.checkFail(s, v);
        return this.inLambda ? env : null;
      }
      case 'success': {
        const e = s.children[0];
        const v = this.evalExpr(e, env);
        this.checkSuccess(s, v);
        if (this.inLambda) { this.taskReturns[this.taskReturns.length - 1]?.push(v.ty); }
        return this.inLambda ? env : null;
      }
      case 'break': case 'continue': return null;
      case 'switch': {
        this.evalSwitch(s, env, false);
        return env;
      }
      default:
        return env;
    }
  }

  private evalSilent(e: Node, env: Env): Val {
    this.silent++;
    try { return this.evalExpr(e, env); } finally { this.silent--; }
  }

  private loop(env: Env, cond: Node | null, update: Node | null, body: Node): Env | null {
    // pass 1 (silent) computes the loop-carried state, pass 2 reports with the joined state
    let header = env.clone();
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 0) this.silent++;
      const e = header.clone();
      if (cond) this.evalExpr(cond, e);
      const bodyEnv = cond ? this.refine(cond, e, true) : e;
      let out = this.execBlock(body, bodyEnv);
      if (out && update) for (const u of update.children) this.evalExpr(u, out);
      if (pass === 0) {
        this.silent--;
        header = joinEnv(header, out) ?? header;
      } else void out;
    }
    return cond ? this.refine(cond, header, false) : header;
  }

  private destructureTypes(t: Ty): Ty[] {
    if (t.n === '[]') return t.a;
    const d = this.p.resolve(this.f, t.n);
    if (d && (d.kind === 'data-class' || d.kind === 'record')) return d.params.map(p => p.ty);
    return [];
  }

  // ---- result related statements -----------------------------------------
  private checkReturn(e: Node, v: Val, _env: Env) {
    if (this.inLambda || this.inMacro) return;
    const rt = this.retTy;
    if (v.nn !== 'non' && v.name && !isUnknown(rt) && lc(rt.n) !== 'void' && !isResult(rt)) {
      this.report(e, v.nn === 'null' ? `'${v.name}' is null but the method returns '${tyToString(rt)}'` : `'${v.name}' may be null; check it first`, { code: 'maybe-null' });
    } else if (v.nn !== 'non' && v.path && v.prop && !isUnknown(rt) && lc(rt.n) !== 'void' && !isResult(rt)) {
      this.report(e, `'${v.path}' may be null; copy it into a final var and check that instead`, { code: 'maybe-null' });
    }
    if (isUnknown(rt) || isUnknown(v.ty)) return;
    if (!isResult(rt) && !isResult(v.ty) && this.incompatible(v.ty, rt)) {
      this.report(e, `Return value: expected '${tyToString(rt)}', found '${tyToString(v.ty)}'`, { code: 'type-mismatch' });
    }
  }

  private checkFail(s: Node, v: Val) {
    if (this.inLambda || this.inMacro) return;
    const rt = this.retTy;
    if (isUnknown(rt)) return;
    if (!isResult(rt)) {
      this.report(s, "'fail' can only be used in a method that returns Result", { code: 'fail-outside-result' });
      return;
    }
    const errTy = rt.a[1];
    if (errTy && !isUnknown(errTy) && !isUnknown(v.ty) && this.incompatible(v.ty, errTy)) {
      this.report(s.children[0], `'fail' value of type '${tyToString(v.ty)}' is not assignable to the error type '${tyToString(errTy)}'`, { code: 'fail-type' });
    }
  }

  private checkSuccess(s: Node, v: Val) {
    if (this.inLambda || this.inMacro) return;
    const rt = this.retTy;
    if (isUnknown(rt)) return;
    if (!isResult(rt)) {
      this.report(s, "'success' can only be used in a method that returns Result", { code: 'success-outside-result' });
      return;
    }
    const okTy = rt.a[0];
    if (okTy && !isUnknown(okTy) && this.incompatible(v.ty, okTy)) {
      this.report(s.children[0], `'success' value: expected '${tyToString(okTy)}', found '${tyToString(v.ty)}'`, { code: 'type-mismatch' });
    }
  }

  // ---- null refinement ----------------------------------------------------
  private refine(cond: Node, env: Env, truthy: boolean): Env {
    const e = env.clone();
    const set = (name: string, nn: NN) => {
      const v = e.vars.get(lc(name));
      if (v) e.vars.set(lc(name), { ...v, nn });
    };
    switch (cond.kind) {
      case 'paren': return this.refine(cond.children[0], env, truthy);
      case 'unary':
        if (cond.text === '!') return this.refine(cond.children[0], env, !truthy);
        return e;
      case 'binary': {
        const [a, b] = cond.children;
        if (cond.text === '==' || cond.text === '!=') {
          const eq = cond.text === '==';
          let nameNode: Node | null = null;
          if (a.kind === 'null-literal' && b.kind === 'name') nameNode = b;
          else if (b.kind === 'null-literal' && a.kind === 'name') nameNode = a;
          if (nameNode) set(nameNode.text, eq === truthy ? 'null' : 'non');
          return e;
        }
        if (cond.text === '&&') {
          if (truthy) return this.refine(b, this.refine(a, env, true), true);
          const left = this.refine(a, env, false);
          const right = this.refine(b, this.refine(a, env, true), false);
          return joinEnv(left, right)!;
        }
        if (cond.text === '||') {
          if (!truthy) return this.refine(b, this.refine(a, env, false), false);
          const left = this.refine(a, env, true);
          const right = this.refine(b, this.refine(a, env, false), true);
          return joinEnv(left, right)!;
        }
        return e;
      }
      default: return e;
    }
  }

  // ---- dereference checks -------------------------------------------------
  private derefCheck(objNode: Node, v: Val) {
    if (this.inMacro && objNode.kind !== 'name') return;
    if (v.name) {
      if (v.nn === 'maybe') this.report(objNode, `'${v.name}' may be null; check it first`, { code: 'maybe-null' });
      else if (v.nn === 'null') this.report(objNode, `'${v.name}' is null; it cannot be dereferenced`, { code: 'null-deref' });
      return;
    }
    if (v.prop && v.path && v.nn !== 'non') {
      const mutable = v.prop.accessors.some(a => a.endsWith('set')) || v.prop.kind === 'field';
      this.report(
        objNode,
        mutable
          ? `'${v.path}' may be null; copy it into a final var and check that instead`
          : `'${v.path}' may be null; check it first`,
        { code: 'maybe-null' },
      );
    } else if (objNode.kind === 'null-literal') {
      this.report(objNode, "'null' cannot be dereferenced", { code: 'null-deref' });
    }
  }

  // ---- expressions --------------------------------------------------------
  private lookupVar(env: Env, name: string): VarInfo | undefined {
    return env.vars.get(lc(name));
  }

  private classType(): Ty {
    return this.cls ? { n: this.cls.name, a: this.cls.generics.map(g => ({ n: g, a: [] })) } : UNKNOWN;
  }

  private findMembers(t: Ty, name: string): MemberDecl[] {
    if (isUnknown(t)) return [];
    const d = this.p.resolve(this.f, t.n);
    if (!d) return [];
    const list = this.allMembers(d);
    // builtin Any members apply to everything
    const any = this.p.builtins.get('any');
    if (any && d !== any) list.push(...any.members);
    return list.filter(m => lc(m.name) === lc(name));
  }

  /** Is the member list of this type complete enough to report unknown members? */
  private membersComplete(t: Ty): boolean {
    const d = this.p.resolve(this.f, t.n);
    if (!d || d.kind === 'builtin') return false;
    const seen = new Set<TypeDecl>();
    const ok = (x: TypeDecl): boolean => {
      if (seen.has(x)) return true;
      seen.add(x);
      if (x.annotations.length) return false;
      if (x.kind === 'builtin') return x.builtinKind === 'exception' || lc(x.name) === 'any';
      for (const s of this.p.supers(x)) {
        const sd = this.p.resolve(x.file ?? this.f, s.n);
        if (!sd) return false;
        if (!ok(sd)) return false;
      }
      return true;
    };
    return ok(d);
  }

  private subst(t: Ty, g: Map<string, Ty>): Ty {
    const hit = g.get(t.n);
    if (hit) return hit;
    return t.a.length ? { n: t.n, a: t.a.map(x => this.subst(x, g)) } : t;
  }

  private memberTy(m: MemberDecl, recv: Ty): Ty {
    if (m.annotations.length) return UNKNOWN;
    const g = new Map<string, Ty>();
    const owner = m.owner;
    if (owner) {
      owner.generics.forEach((gn, i) => g.set(gn, owner === this.p.resolve(this.f, recv.n) ? (recv.a[i] ?? UNKNOWN) : UNKNOWN));
    }
    for (const mg of m.generics) g.set(mg, UNKNOWN);
    return this.subst(m.ty, g);
  }

  private evalArgs(args: Node[], env: Env): Val[] {
    return args.map(a => this.evalExpr(a, env));
  }

  private paramRange(cands: MemberDecl[]): [number, number] {
    let lo = Infinity, hi = 0;
    for (const c of cands) {
      const min = c.params.filter(p => !p.hasDefault).length;
      lo = Math.min(lo, min);
      hi = Math.max(hi, c.params.length);
    }
    return [lo, hi];
  }

  private checkCall(at: Node, label: string, cands: MemberDecl[], args: Node[], vals: Val[]) {
    if (!cands.length || cands.some(c => !c.node && c.owner?.kind === 'builtin' && false)) return;
    const n = args.length;
    const fits = cands.filter(c => n >= c.params.filter(p => !p.hasDefault).length && n <= c.params.length);
    if (!fits.length) {
      const [lo, hi] = this.paramRange(cands);
      const exp = lo === hi ? `${lo}` : `${lo} to ${hi}`;
      this.report(at, `${label} expects ${exp} argument(s), found ${n}`, { code: 'argument-count' });
      return;
    }
    const target = fits[0];
    if (cands.length === 1 || fits.length === 1) {
      target.params.forEach((p, i) => {
        if (i >= vals.length) return;
        const v = vals[i];
        const user = target.node !== null;
        if (user && (v.ty.n === 'null' || v.nn === 'null' || (v.name && v.nn === 'maybe') || (v.prop && v.nn !== 'non'))) {
          const nm = v.ty.n === 'null' && !v.name ? 'null' : v.name ?? v.path ?? 'null';
          if (!isUnknown(p.ty) && lc(p.ty.n) !== 'any' && lc(p.ty.n) !== 'dynamic') {
            this.report(args[i], v.nn === 'maybe' || v.ty.n !== 'null'
              ? `'${nm}' may be null; check it first (it is passed to a non-null parameter)`
              : `'null' cannot be passed: it is passed to a non-null parameter`, { code: 'null-argument' });
          }
        } else if (!isUnknown(p.ty) && PRIMS.has(lc(p.ty.n)) && PRIMS.has(lc(v.ty.n)) && this.incompatible(v.ty, p.ty)) {
          this.report(args[i], `Argument ${i + 1} of '${target.name}': expected '${tyToString(p.ty)}', found '${tyToString(v.ty)}'`, { code: 'type-mismatch' });
        }
      });
    }
  }

  private evalExpr(n: Node, env: Env): Val {
    const v = this.evalExprInner(n, env);
    if (this.collect && !this.silent) this.typeMap.set(n, v.ty);
    else if (this.collect && !this.typeMap.has(n)) this.typeMap.set(n, v.ty);
    return v;
  }

  private typeMapSet(n: Node, t: Ty) {
    if (this.collect) this.typeMap.set(n, t);
  }

  private setRes(n: Node, r: Res) {
    if (this.collect) this.resMap.set(n, r);
  }

  private evalExprInner(n: Node, env: Env): Val {
    switch (n.kind) {
      case 'int-literal': return val({ n: 'Int', a: [] });
      case 'float-literal': return val({ n: 'Float', a: [] });
      case 'bool-literal': return val({ n: 'Boolean', a: [] });
      case 'null-literal': return { ty: NULLTY, nn: 'null' };
      case 'string':
        for (const c of n.children) if (c.kind === 'interpolation') this.evalExpr(c.children[0], env);
        return val({ n: 'String', a: [] });
      case 'paren': return this.evalExpr(n.children[0], env);
      case 'this': return val(this.classType());
      case 'placeholder': return UNK;
      case 'error':
        // `receiver.` with a missing member name: still evaluate the receiver (completion needs its type)
        for (const c of n.children) this.evalExpr(c, env);
        return UNK;
      case 'splice': this.evalExpr(n.children[0], env); return UNK;
      case 'name': return this.evalName(n, env);
      case 'generic-ref': {
        const d = this.p.resolve(this.f, n.text);
        return { ty: { n: n.text, a: n.children.map(tyFromNode) }, nn: 'non', typeRef: d };
      }
      case 'member': return this.evalMember(n, env);
      case 'call': return this.evalCall(n, env);
      case 'index': {
        const o = this.evalExpr(n.children[0], env);
        this.derefCheck(n.children[0], o);
        const i = this.evalExpr(n.children[1], env);
        const k = lc(o.ty.n);
        if (k === 'list') return val(o.ty.a[0] ?? UNKNOWN);
        if (k === 'dictionary') return val(o.ty.a[1] ?? UNKNOWN);
        if (o.ty.n === '[]' && n.children[1].kind === 'int-literal') return val(o.ty.a[Number(n.children[1].text)] ?? UNKNOWN);
        void i;
        return UNK;
      }
      case 'propagate': {
        const o = this.evalExpr(n.children[0], env);
        if (!this.inLambda && !this.inMacro && this.method && !isUnknown(this.retTy) && !isResult(this.retTy)) {
          this.report(n, "'?' can only be used in a method that returns Result", { code: 'propagate-outside-result' });
        } else if (!this.inLambda && this.method && isResult(this.retTy) && isResult(o.ty)) {
          const me = this.retTy.a[1], oe = o.ty.a[1];
          if (me && oe && !isUnknown(me) && !isUnknown(oe) && this.incompatible(oe, me)) {
            this.report(n, `'?' propagates '${tyToString(oe)}', which is not assignable to the error type '${tyToString(me)}'`, { code: 'propagate-type' });
          }
        }
        return isResult(o.ty) ? val(o.ty.a[0] ?? UNKNOWN) : UNK;
      }
      case 'unwrap': {
        const o = this.evalExpr(n.children[0], env);
        return isResult(o.ty) ? val(o.ty.a[0] ?? UNKNOWN) : UNK;
      }
      case 'postfix': {
        const o = this.evalExpr(n.children[0], env);
        return val(o.ty);
      }
      case 'unary': {
        const o = this.evalExpr(n.children[0], env);
        if (n.text === '!') return val({ n: 'Boolean', a: [] });
        return val(o.ty);
      }
      case 'binary': return this.evalBinary(n, env);
      case 'ternary': {
        const [c, a, b] = n.children;
        this.evalExpr(c, env);
        const va = this.evalExpr(a, this.refine(c, env, true));
        const vb = this.evalExpr(b, this.refine(c, env, false));
        return { ty: lc(va.ty.n) === lc(vb.ty.n) ? va.ty : UNKNOWN, nn: joinNN(va.nn, vb.nn) };
      }
      case 'assign': return this.evalAssign(n, env);
      case 'is': {
        this.evalExpr(n.children[0], env);
        this.checkTypeNode(n.children[1]);
        return val({ n: 'Boolean', a: [] });
      }
      case 'as': {
        this.evalExpr(n.children[0], env);
        this.checkTypeNode(n.children[1]);
        return val(tyFromNode(n.children[1]));
      }
      case 'cascade': return this.evalCascade(n, env);
      case 'lambda': {
        const [params, body] = n.children;
        const e = env.clone();
        for (const prm of params.children) {
          const tn = prm.children.find(c => c.kind === 'type' || c.kind === 'tuple-type');
          if (tn) this.checkTypeNode(tn);
          e.vars.set(lc(prm.text), { name: prm.text, ty: tn ? tyFromNode(tn) : UNKNOWN, nn: 'non', kind: 'lambda', final: false, node: prm });
        }
        this.inLambda++;
        this.taskReturns.push([]);
        if (body.kind === 'block') this.execBlock(body, e); else this.evalExpr(body, e);
        this.taskReturns.pop();
        this.inLambda--;
        return val({ n: 'Function', a: [] });
      }
      case 'list-literal': {
        const vs = n.children.map(c => this.evalExpr(c, env));
        if (!vs.length) return val({ n: 'List', a: [UNKNOWN] });
        const first = lc(vs[0].ty.n);
        if (vs.every(v => lc(v.ty.n) === first)) return val({ n: 'List', a: [vs[0].ty] });
        return val({ n: '[]', a: vs.map(v => v.ty) });
      }
      case 'dict-literal': {
        for (const en of n.children) for (const c of en.children) this.evalExpr(c, env);
        return val({ n: 'Dictionary', a: [UNKNOWN, UNKNOWN] });
      }
      case 'task': {
        this.inLambda++;
        this.taskReturns.push([]);
        this.execBlock(n.children[0], env.clone());
        const rets = this.taskReturns.pop()!;
        this.inLambda--;
        const t = rets.find(r => !isUnknown(r) && lc(r.n) !== 'void') ?? (rets.length ? UNKNOWN : VOID);
        const name = n.text === 'fiber' ? 'Fiber' : n.text === 'virtual' ? 'VirtualThread' : 'Thread';
        return val({ n: name, a: [t] });
      }
      case 'switch': return this.evalSwitch(n, env, true);
      case 'quote': {
        // template code is checked at the expansion site; only splices run in the macro scope
        const walk = (x: Node) => {
          if (x.kind === 'splice') { this.evalExpr(x.children[0], env); return; }
          for (const c of x.children) walk(c);
        };
        walk(n);
        return UNK;
      }
      default: {
        for (const c of n.children) this.evalExpr(c, env);
        return UNK;
      }
    }
  }

  private evalBinary(n: Node, env: Env): Val {
    const [a, b] = n.children;
    const op = n.text;
    if (op === '&&' || op === '||') {
      this.evalExpr(a, env);
      const rhsEnv = this.refine(a, env, op === '&&');
      this.evalExpr(b, rhsEnv);
      return val({ n: 'Boolean', a: [] });
    }
    const l = this.evalExpr(a, env);
    const r = this.evalExpr(b, env);
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) return val({ n: 'Boolean', a: [] });
    const ln = lc(l.ty.n), rn = lc(r.ty.n);
    if (op === '+' && (ln === 'string' || rn === 'string')) return val({ n: 'String', a: [] });
    if (ln === 'float' || rn === 'float') return (PRIMS.has(ln) || isUnknown(l.ty)) && (PRIMS.has(rn) || isUnknown(r.ty)) ? val({ n: 'Float', a: [] }) : UNK;
    if (ln === 'int' && rn === 'int') return val({ n: 'Int', a: [] });
    return UNK;
  }

  private evalName(n: Node, env: Env): Val {
    const name = n.text;
    const v = this.lookupVar(env, name);
    if (v) { this.setRes(n, { varDecl: v.node, varName: v.name, ty: v.ty }); return { ty: v.ty, nn: v.nn, name: v.name }; }
    // implicit this: members of the enclosing class chain
    if (this.cls) {
      const mems = this.allMembers(this.cls).filter(m => lc(m.name) === lc(name));
      const prop = mems.find(m => m.kind === 'property' || m.kind === 'field' || m.kind === 'enum-entry');
      if (prop) {
        this.setRes(n, { member: prop });
        return { ty: this.memberTy(prop, this.classType()), nn: prop.nullInit ? 'maybe' : 'non', prop, path: name };
      }
      const mth = mems.find(m => m.kind === 'method');
      if (mth) { this.setRes(n, { member: mth }); return { ty: UNKNOWN, nn: 'non' }; }
    }
    const tl = this.p.topLevelVariable(this.f, name);
    if (tl) { this.setRes(n, { member: tl }); return val(tl.ty); }
    const tms = this.p.topLevelMethods(this.f, name);
    if (tms.length) { this.setRes(n, { member: tms[0] }); return UNK; }
    const d = this.p.resolve(this.f, name);
    if (d) { this.setRes(n, { typeRef: d }); return { ty: { n: d.name, a: [] }, nn: 'non', typeRef: d }; }
    if (GLOBAL_FNS.has(lc(name)) || lc(name) === 'super') return UNK;
    if (this.inMacro && (lc(name) === 'target' || lc(name) === 'macro')) return UNK;
    if (this.macroNames.has(lc(name))) return UNK;
    this.reportName(n, `Unknown name '${name}'`, { code: 'unknown-name', data: { name } });
    return UNK;
  }

  private evalMember(n: Node, env: Env): Val {
    const objNode = n.children[0];
    const o = this.evalExpr(objNode, env);
    const name = n.text;
    if (o.typeRef) {
      // static member / enum entry
      const mems = this.allMembers(o.typeRef).filter(m => lc(m.name) === lc(name));
      const m = mems[0];
      if (m) { this.setRes(n, { member: m }); return { ty: m.kind === 'enum-entry' ? { n: o.typeRef.name, a: [] } : this.memberTy(m, o.ty), nn: 'non' }; }
      return UNK;
    }
    this.derefCheck(objNode, o);
    if (o.nn !== 'non' && o.name) { /* reported above */ }
    const mems = this.findMembers(o.ty, name);
    if (mems.length) {
      const m = mems.find(x => x.kind === 'property' || x.kind === 'field') ?? mems[0];
      this.setRes(n, { member: m });
      const path = o.name ? `${o.name}.${name}` : o.path ? `${o.path}.${name}` : name;
      if (m.kind === 'property' || m.kind === 'field') {
        return { ty: this.memberTy(m, o.ty), nn: m.nullInit ? 'maybe' : 'non', prop: m, path };
      }
      return { ty: this.memberTy(m, o.ty), nn: 'non' };
    }
    if (!isUnknown(o.ty) && this.membersComplete(o.ty) && !this.inMacro) {
      this.report(
        { start: n.nameStart ?? n.start, end: n.nameEnd ?? n.end, line: n.line, col: n.col },
        `Unknown member '${name}' of type '${tyToString(o.ty)}'`, { code: 'unknown-member', data: { name } },
      );
    }
    return UNK;
  }

  private evalCall(n: Node, env: Env): Val {
    const callee = n.children[0];
    const args = n.children.slice(1);
    // callee forms
    if (callee.kind === 'name') {
      const name = callee.text;
      const v = this.lookupVar(env, name);
      if (v) { this.evalArgs(args, env); return UNK; } // function-typed variable
      if (GLOBAL_FNS.has(lc(name))) { this.evalArgs(args, env); return val(VOID); }
      // constructor of a type
      const d = this.p.resolve(this.f, name);
      const own = this.cls ? this.allMembers(this.cls).filter(m => lc(m.name) === lc(name) && m.kind === 'method') : [];
      const top = this.p.topLevelMethods(this.f, name);
      if (own.length || (top.length && !d)) {
        const vals = this.evalArgs(args, env);
        const cands = own.length ? own : top;
        this.setRes(callee, { member: cands[0] });
        this.checkCall(callee, `Method '${cands[0].name}'`, cands, args, vals);
        const m = cands[0];
        return val(m.annotations.length ? UNKNOWN : this.subst(m.ty, new Map(m.generics.map(g => [g, UNKNOWN] as [string, Ty]))));
      }
      if (d) {
        const vals = this.evalArgs(args, env);
        this.setRes(callee, { typeRef: d });
        this.checkCtor(callee, d, args, vals);
        return val({ n: d.name, a: [] });
      }
      this.evalArgs(args, env);
      if (this.macroNames.has(lc(name))) return UNK;
      this.reportName(callee, `Unknown name '${name}'`, { code: 'unknown-name', data: { name } });
      return UNK;
    }
    if (callee.kind === 'generic-ref') {
      const vals = this.evalArgs(args, env);
      const d = this.p.resolve(this.f, callee.text);
      for (const a of callee.children) this.checkTypeNode(a);
      if (!d) this.reportName(callee, `Unknown name '${callee.text}'`, { code: 'unknown-name', data: { name: callee.text } });
      else this.checkCtor(callee, d, args, vals);
      return val({ n: callee.text, a: callee.children.map(tyFromNode) });
    }
    if (callee.kind === 'member') {
      const objNode = callee.children[0];
      const o = this.evalExpr(objNode, env);
      const vals = this.evalArgs(args, env);
      if (!o.typeRef) this.derefCheck(objNode, o);
      const mems = this.findMembers(o.ty, callee.text).filter(m => m.kind === 'method');
      if (mems.length) {
        const user = mems.filter(m => m.node !== null);
        const cand = user.length === 1 ? user[0] : user.find(m => m.params.length === args.length) ?? mems[0];
        this.setRes(callee, { member: cand });
        if (user.length) this.checkCall(callee, `Method '${callee.text}'`, user, args, vals);
        const m = mems[0];
        // Result.success / Result.error / generic helpers
        let ret = this.memberTy(m, o.ty);
        if (lc(o.ty.n) === 'result' && o.typeRef) ret = { n: 'Result', a: [vals[0]?.ty ?? UNKNOWN, UNKNOWN] };
        if (lc(m.name) === 'map' || lc(m.name) === 'reduce' || lc(m.name) === 'mapError') ret = lc(o.ty.n) === 'result' ? { n: 'Result', a: [UNKNOWN, UNKNOWN] } : UNKNOWN;
        if (lc(o.ty.n) === 'list' && (lc(m.name) === 'filter')) ret = o.ty;
        return val(ret);
      }
      if (!isUnknown(o.ty) && this.membersComplete(o.ty) && !this.inMacro) {
        this.report(
          { start: callee.nameStart ?? callee.start, end: callee.nameEnd ?? callee.end, line: callee.line, col: callee.col },
          `Unknown member '${callee.text}' of type '${tyToString(o.ty)}'`, { code: 'unknown-member', data: { name: callee.text } },
        );
      }
      return UNK;
    }
    // call of an arbitrary expression
    this.evalExpr(callee, env);
    this.evalArgs(args, env);
    return UNK;
  }

  private checkCtor(at: Node, d: TypeDecl, args: Node[], vals: Val[]) {
    if (d.kind === 'builtin') return;
    if (d.kind === 'interface') {
      this.report(at, `Cannot create an instance of interface '${d.name}'`, { code: 'instantiate-interface' });
      return;
    }
    if (d.kind === 'enum') return;
    if (d.isAbstract && d.kind === 'class') {
      this.report(at, `Cannot create an instance of abstract class '${d.name}'`, { code: 'instantiate-abstract' });
      return;
    }
    if (d.annotations.length) return;
    let cands: MemberDecl[] = d.members.filter(m => m.kind === 'constructor');
    if (d.kind === 'data-class' || d.kind === 'record') {
      if (!cands.length) {
        cands = [{ name: d.name, kind: 'constructor', node: d.node, owner: d, ty: { n: d.name, a: [] }, params: d.params, generics: [], isStatic: false, isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: [], hasInit: false, nullInit: false, hasBody: true, annotations: [], placeholder: false }];
      }
    } else if (d.kind === 'exception') {
      if (!cands.length) {
        const params = d.params.length ? d.params : [{ name: 'message', ty: { n: 'String', a: [] }, hasDefault: true, node: null }];
        cands = [{ name: d.name, kind: 'constructor', node: d.node, owner: d, ty: { n: d.name, a: [] }, params, generics: [], isStatic: false, isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: [], hasInit: false, nullInit: false, hasBody: true, annotations: [], placeholder: false }];
      }
    } else if (!cands.length) {
      // class without explicit constructor: default constructor, or inherited one if based on something
      if (d.based.length) return;
      cands = [{ name: d.name, kind: 'constructor', node: d.node, owner: d, ty: { n: d.name, a: [] }, params: [], generics: [], isStatic: false, isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: [], hasInit: false, nullInit: false, hasBody: true, annotations: [], placeholder: false }];
    }
    this.checkCall(at, `Constructor of '${d.name}'`, cands, args, vals);
  }

  private evalAssign(n: Node, env: Env): Val {
    const [target, value] = n.children;
    const v = this.evalExpr(value, env);
    this.assignTo(target, n, v, env, null);
    return v;
  }

  /** target is a name / member / index (optionally relative to a cascade receiver) */
  private assignTo(target: Node, at: Node, v: Val, env: Env, receiver: Val | null) {
    if (target.kind === 'name' && !receiver) {
      const vi = this.lookupVar(env, target.text);
      if (vi) {
        this.setRes(target, { varDecl: vi.node, varName: vi.name, ty: vi.ty });
        this.typeMapSet(target, vi.ty);
        if (vi.final) this.reportName(target, `Cannot assign to final variable '${vi.name}'`, { code: 'assign-final' });
        if (at.text === '=') {
          env.vars.set(lc(vi.name), { ...vi, nn: v.nn });
          if (!isUnknown(vi.ty) && this.incompatible(v.ty, vi.ty) && vi.kind !== 'lambda') {
            this.report(at, `Cannot assign '${tyToString(v.ty)}' to '${vi.name}' of type '${tyToString(vi.ty)}'`, { code: 'type-mismatch' });
          }
        } else env.vars.set(lc(vi.name), { ...vi, nn: 'non' });
        return;
      }
      // implicit this property
      if (this.cls) {
        const prop = this.allMembers(this.cls).find(m => lc(m.name) === lc(target.text) && (m.kind === 'property' || m.kind === 'field'));
        if (prop) {
          this.setRes(target, { member: prop });
          this.checkPropertyWrite(target, prop, env);
          return;
        }
      }
      this.evalExpr(target, env);
      return;
    }
    if (target.kind === 'member') {
      const objNode = target.children[0];
      let recv: Val;
      if (receiver && !objNode) recv = receiver;
      else recv = this.evalExpr(objNode, env);
      const isThis = objNode?.kind === 'this';
      if (!isThis && !recv.typeRef) this.derefCheck(objNode, recv);
      const mems = this.findMembers(recv.ty, target.text).filter(m => m.kind === 'property' || m.kind === 'field');
      if (mems.length) {
        this.setRes(target, { member: mems[0] });
        this.checkPropertyWrite(target, mems[0], env, isThis);
        if (!isUnknown(mems[0].ty) && at.text === '=' && this.incompatible(v.ty, mems[0].ty)) {
          this.report(at, `Cannot assign '${tyToString(v.ty)}' to '${target.text}' of type '${tyToString(mems[0].ty)}'`, { code: 'type-mismatch' });
        }
      } else if (!isUnknown(recv.ty) && this.membersComplete(recv.ty) && !this.inMacro) {
        this.report(
          { start: target.nameStart ?? target.start, end: target.nameEnd ?? target.end, line: target.line, col: target.col },
          `Unknown member '${target.text}' of type '${tyToString(recv.ty)}'`, { code: 'unknown-member', data: { name: target.text } },
        );
      }
      return;
    }
    this.evalExpr(target, env);
  }

  private checkPropertyWrite(at: Node, prop: MemberDecl, env: Env, viaThis = true) {
    if (prop.kind === 'property') {
      const writable = prop.accessors.some(a => a.endsWith('set'));
      const inOwnCtor = this.inCtor && this.cls !== null && prop.owner === this.cls && viaThis;
      if (!writable && !inOwnCtor && !prop.accessors.length === false) {
        this.reportName(at, `Property '${prop.name}' is read-only`, { code: 'readonly-property' });
      } else if (inOwnCtor) env.assigned.add(lc(prop.name));
      if (writable && this.inCtor) env.assigned.add(lc(prop.name));
    } else if (prop.kind === 'field' && this.inCtor) env.assigned.add(lc(prop.name));
  }

  private evalCascade(n: Node, env: Env): Val {
    const recv = this.evalExpr(n.children[0], env);
    if (!recv.typeRef) this.derefCheck(n.children[0], recv);
    for (const sec of n.children.slice(1)) {
      const chain = sec.children[0];
      if (chain.kind === 'assign') {
        const v = this.evalExpr(chain.children[1], env);
        const t = chain.children[0];
        // target is relative to the receiver: a name-ish member without object
        if (t.kind === 'member' && t.children.length === 0) {
          const mems = this.findMembers(recv.ty, t.text).filter(m => m.kind === 'property' || m.kind === 'field');
          if (mems.length) { this.setRes(t, { member: mems[0] }); this.checkPropertyWrite(t, mems[0], env, false); }
          else if (!isUnknown(recv.ty) && this.membersComplete(recv.ty)) {
            this.report({ start: t.nameStart ?? t.start, end: t.nameEnd ?? t.end, line: t.line, col: t.col }, `Unknown member '${t.text}' of type '${tyToString(recv.ty)}'`, { code: 'unknown-member', data: { name: t.text } });
          }
        } else this.evalRelative(t, recv, env);
        void v;
      } else this.evalRelative(chain, recv, env);
    }
    return { ty: recv.ty, nn: recv.nn, name: recv.name };
  }

  /** Evaluates a member/call chain whose innermost member has no object (cascade section). */
  private evalRelative(chain: Node, recv: Val, env: Env): Val {
    if (chain.kind === 'member' && chain.children.length === 0) {
      const mems = this.findMembers(recv.ty, chain.text);
      if (!mems.length && !isUnknown(recv.ty) && this.membersComplete(recv.ty)) {
        this.report({ start: chain.nameStart ?? chain.start, end: chain.nameEnd ?? chain.end, line: chain.line, col: chain.col }, `Unknown member '${chain.text}' of type '${tyToString(recv.ty)}'`, { code: 'unknown-member', data: { name: chain.text } });
      }
      const m = mems[0];
      if (m) this.setRes(chain, { member: m });
      return m ? val(this.memberTy(m, recv.ty)) : UNK;
    }
    if (chain.kind === 'member') {
      const o = this.evalRelative(chain.children[0], recv, env);
      const mems = this.findMembers(o.ty, chain.text);
      return mems[0] ? val(this.memberTy(mems[0], o.ty)) : UNK;
    }
    if (chain.kind === 'call') {
      const callee = chain.children[0];
      const args = chain.children.slice(1);
      const vals = this.evalArgs(args, env);
      if (callee.kind === 'member' && callee.children.length === 0) {
        const mems = this.findMembers(recv.ty, callee.text).filter(m => m.kind === 'method');
        const user = mems.filter(m => m.node !== null);
        if (mems.length) this.setRes(callee, { member: user[0] ?? mems[0] });
        if (user.length) this.checkCall(callee, `Method '${callee.text}'`, user, args, vals);
        else if (!mems.length && !isUnknown(recv.ty) && this.membersComplete(recv.ty)) {
          this.report({ start: callee.nameStart ?? callee.start, end: callee.nameEnd ?? callee.end, line: callee.line, col: callee.col }, `Unknown member '${callee.text}' of type '${tyToString(recv.ty)}'`, { code: 'unknown-member', data: { name: callee.text } });
        }
        return mems[0] ? val(this.memberTy(mems[0], recv.ty)) : UNK;
      }
      const o = this.evalRelative(callee, recv, env);
      return o;
    }
    if (chain.kind === 'index') {
      const o = this.evalRelative(chain.children[0], recv, env);
      this.evalExpr(chain.children[1], env);
      return o;
    }
    return this.evalExpr(chain, env);
  }

  // ---- switch -------------------------------------------------------------
  private evalSwitch(n: Node, env: Env, asExpr: boolean): Val {
    const subject = n.children[0];
    const sv = this.evalExpr(subject, env);
    const cases = n.children.slice(1).filter(c => c.kind === 'case');
    const subjDecl = this.p.resolve(this.f, sv.ty.n);
    const isRes = isResult(sv.ty);
    let hasSuccess = false, hasError = false, hasCatchAll = false;
    const errorTypes: Ty[] = [];
    const outs: Array<Env | null> = [];
    const armTys: Ty[] = [];
    const enumSeen = new Set<string>();

    for (const c of cases) {
      const body = c.children[c.children.length - 1];
      const pats = c.children.slice(0, -1);
      const e = env.clone();
      for (const p of pats) {
        switch (p.kind) {
          case 'pattern-success': {
            hasSuccess = true;
            const b = p.children.find(x => x.kind === 'binding');
            if (b) e.vars.set(lc(b.text), { name: b.text, ty: isRes ? (sv.ty.a[0] ?? UNKNOWN) : UNKNOWN, nn: 'non', kind: 'binding', final: false, node: b });
            break;
          }
          case 'pattern-error': {
            hasError = true;
            const tn = p.children.find(x => x.kind === 'type' || x.kind === 'tuple-type');
            const b = p.children.find(x => x.kind === 'binding');
            let et: Ty = isRes ? (sv.ty.a[1] ?? UNKNOWN) : UNKNOWN;
            if (tn) {
              this.checkTypeNode(tn);
              et = tyFromNode(tn);
              // an earlier pattern with the same or a more general type makes this one unreachable
              const earlier = errorTypes.find(x => this.isSubtypeTy(et, x) );
              if (earlier) {
                this.report(p, `Pattern 'error(${tyToString(et)})' is unreachable: '${tyToString(earlier)}' is handled earlier`, { code: 'unreachable-pattern' });
              }
              errorTypes.push(et);
            } else errorTypes.push(isRes ? (sv.ty.a[1] ?? UNKNOWN) : UNKNOWN);
            if (b) e.vars.set(lc(b.text), { name: b.text, ty: et, nn: 'non', kind: 'binding', final: false, node: b });
            break;
          }
          case 'pattern-name': {
            const isEnumConst = subjDecl?.kind === 'enum' && subjDecl.members.some(m => m.kind === 'enum-entry' && lc(m.name) === lc(p.text.split('.').pop()!));
            if (isEnumConst) enumSeen.add(lc(p.text.split('.').pop()!));
            else if (!p.text.includes('.')) hasCatchAll = true;
            break;
          }
          case 'pattern-value': this.evalExpr(p.children[0], env); break;
          default: break;
        }
      }
      let out: Env | null;
      let armTy: Ty = UNKNOWN;
      if (body.kind === 'block' || body.kind === 'return' || body.kind === 'fail' || body.kind === 'success' || body.kind === 'break' || body.kind === 'continue') {
        if (body.kind === 'success') {
          const v = this.evalExpr(body.children[0], e);
          this.checkSuccess(body, v);
          armTy = { n: 'Result', a: [v.ty, UNKNOWN] };
          out = asExpr ? e : null;
        } else if (body.kind === 'fail') {
          const v = this.evalExpr(body.children[0], e);
          this.checkFail(body, v);
          out = null;
          armTy = { n: '!', a: [] };
        } else {
          out = this.execStmt(body, e, []);
          if (asExpr && body.kind === 'block') out = out ?? null;
        }
      } else {
        const v = this.evalExpr(body, e);
        armTy = v.ty;
        out = e;
      }
      armTys.push(armTy);
      outs.push(asExpr ? e : out);
    }

    if (isRes && !this.inMacro) {
      if (!(hasSuccess && hasError) && !hasCatchAll) {
        this.report(n, "A switch on a Result must handle both 'success' and 'error'", { code: 'switch-result-incomplete' });
      }
    } else if (asExpr && !hasCatchAll && cases.length) {
      if (subjDecl?.kind === 'enum') {
        const missing = subjDecl.members.filter(m => m.kind === 'enum-entry' && !enumSeen.has(lc(m.name))).map(m => m.name);
        if (missing.length) this.report(n, `Switch expression does not cover all cases: missing ${missing.join(', ')}`, { code: 'switch-incomplete' });
      } else if (!cases.some(c => c.children.slice(0, -1).some(p => p.kind === 'pattern-success' || p.kind === 'pattern-error'))) {
        this.report(n, 'Switch expression needs a catch-all case (for example `unknown -> ...`) or must cover every case', { code: 'switch-incomplete' });
      }
    }

    if (asExpr) {
      const real = armTys.filter(t => t.n !== '!');
      const same = real.length > 0 && real.every(t => lc(t.n) === lc(real[0].n));
      let ty = same ? real[0] : UNKNOWN;
      if (same && isResult(real[0])) ty = { n: 'Result', a: [real.find(r => !isUnknown(r.a[0]))?.a[0] ?? UNKNOWN, UNKNOWN] };
      return val(ty);
    }
    return UNK;
  }

  private isSubtypeTy(sub: Ty, sup: Ty): boolean {
    if (lc(sub.n) === lc(sup.n)) return true;
    const d = this.p.resolve(this.f, sub.n);
    if (!d) return false;
    const seen = new Set<TypeDecl>();
    const up = (x: TypeDecl): boolean => {
      if (seen.has(x)) return false;
      seen.add(x);
      for (const s of this.p.supers(x)) {
        if (lc(s.n) === lc(sup.n)) return true;
        const sd = this.p.resolve(x.file ?? this.f, s.n);
        if (sd && up(sd)) return true;
      }
      return false;
    };
    return up(d);
  }

  // ---- type compatibility (only definite mismatches) ----------------------
  private incompatible(from: Ty, to: Ty): boolean {
    if (isUnknown(from) || isUnknown(to)) return false;
    const fn = lc(from.n), tn = lc(to.n);
    if (fn === 'null' || fn === '!' || tn === 'any' || tn === 'dynamic' || fn === 'dynamic' || fn === 'any') return false;
    if (fn === tn) return false;
    if (this.typeParams.has(from.n) || this.typeParams.has(to.n)) return false;
    if (from.n === '[]' || to.n === '[]') return false;
    if (lc(from.n) === 'function' || lc(to.n) === 'function') return false;
    const fp = PRIMS.has(fn), tp = PRIMS.has(tn);
    if (fp && tp) return !(fn === 'int' && tn === 'float');
    const fd = this.p.resolve(this.f, from.n);
    const td = this.p.resolve(this.f, to.n);
    if (!fd || !td) return false;
    if (td.kind === 'builtin' && (td.builtinKind === 'interface' || td.builtinKind === 'variadic' || td.builtinKind === 'opaque')) return false;
    if (fd.kind === 'builtin' && (fd.builtinKind === 'variadic' || fd.builtinKind === 'opaque' || fd.builtinKind === 'interface')) return false;
    if (fd.annotations.length || td.annotations.length) return false;
    if (this.isSubtypeTy(from, to)) return false;
    return true;
  }
}
