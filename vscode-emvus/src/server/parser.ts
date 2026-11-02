// Recursive-descent parser for Emvus. Node kinds follow Ring0/AST.md.
// Tolerant: always makes progress, collects diagnostics, never throws.
import { Node, mk } from './ast';
import { Token, tokenize } from './lexer';

export interface Diag {
  message: string;
  start: number;
  end: number;
  line: number;
  col: number;
  severity: 'error' | 'warning';
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'abstract', 'override', 'final', 'scoped']);
const TYPE_DECL = new Set(['class', 'interface', 'enum', 'record', 'exception', 'macro']);
const NAME_LIKE = new Set(['exception', 'method', 'macro', 'record', 'class', 'interface', 'enum', 'package', 'use']);
const CONTROL = new Set(['if', 'while', 'for', 'switch', 'return', 'fail', 'break', 'continue']);

export function computeLineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1);
  return s;
}

class Parser {
  i = 0;
  diags: Diag[] = [];
  silent = 0;

  constructor(private t: Token[], private src: string) {}

  // ---- token helpers ------------------------------------------------------
  get cur(): Token { return this.t[Math.min(this.i, this.t.length - 1)]; }
  peek(o = 0): Token { return this.t[Math.min(this.i + o, this.t.length - 1)]; }
  get prev(): Token { return this.t[Math.max(0, this.i - 1)]; }
  eof(): boolean { return this.cur.kind === 'eof'; }
  isSym(s: string, o = 0): boolean { const k = this.peek(o); return k.kind === 'sym' && k.text === s; }
  isKw(s: string, o = 0): boolean { const k = this.peek(o); return k.kind === 'kw' && k.text === s; }
  /** keyword or identifier with this text */
  isWord(s: string, o = 0): boolean { const k = this.peek(o); return (k.kind === 'id' || k.kind === 'kw') && k.text === s; }
  adv(): Token { const k = this.cur; if (!this.eof()) this.i++; return k; }
  error(message: string, tok: Token = this.cur, severity: Diag['severity'] = 'error') {
    if (this.silent) return;
    this.diags.push({ message, start: tok.start, end: Math.max(tok.end, tok.start + 1), line: tok.line, col: tok.col, severity });
  }
  expect(sym: string, message: string): boolean {
    if (this.isSym(sym)) { this.adv(); return true; }
    this.error(message);
    return false;
  }
  node(kind: string, text: string, first: Token, children: Node[] = []): Node {
    const last = this.prev;
    return mk(kind, text, first.start, Math.max(last.end, first.end), first.line, first.col, children);
  }
  /** can this token be used as a name? identifiers always, keywords only in name positions */
  isNameTok(o = 0): boolean { const k = this.peek(o); return k.kind === 'id' || k.kind === 'kw'; }

  // ---- file ---------------------------------------------------------------
  parseFile(): Node {
    const first = this.cur;
    const file = mk('file', '', 0, this.src.length, 1, 1, []);
    while (!this.eof()) {
      const before = this.i;
      const m = this.parseMember(null, true);
      if (m) file.children.push(m);
      if (this.i === before) { this.error(`Unexpected '${this.cur.text}'`); this.adv(); }
    }
    void first;
    return file;
  }

  // ---- annotations / modifiers -------------------------------------------
  parseAnnotations(into: Node[]) {
    while (this.isSym('@')) {
      const at = this.adv();
      if (!this.isNameTok()) { this.error("Expected annotation name after '@'"); continue; }
      const name = this.adv();
      const a = this.node('annotation', name.text, at);
      a.nameStart = name.start; a.nameEnd = name.end;
      if (this.isSym('(') && !this.cur.nl) {
        this.adv();
        a.children.push(...this.parseArgsUntil(')', "Expected ')' after annotation arguments"));
        a.end = this.prev.end;
      }
      into.push(a);
    }
  }

  parseModifiers(into: Node[]): Node {
    const first = this.cur;
    const mods = mk('modifiers', '', first.start, first.start, first.line, first.col, []);
    for (;;) {
      if (this.isSym('@')) { this.parseAnnotations(into); continue; }
      const k = this.cur;
      if (k.kind === 'kw' && MODIFIERS.has(k.text)) {
        // `final var x` / `final Type x` — modifier of a local is handled by callers, here it's a member modifier
        this.adv();
        mods.children.push(mk('modifier', k.text, k.start, k.end, k.line, k.col));
        continue;
      }
      break;
    }
    if (mods.children.length) mods.end = this.prev.end;
    return mods;
  }

  // ---- types --------------------------------------------------------------
  /** Parses a type; returns undefined (position restored) when none starts here. */
  tryType(): Node | undefined {
    const save = this.i;
    this.silent++;
    const t = this.parseType();
    this.silent--;
    if (!t) this.i = save;
    return t;
  }

  parseType(): Node | undefined {
    const first = this.cur;
    if (this.isSym('[')) {
      this.adv();
      const kids: Node[] = [];
      for (;;) {
        const e = this.parseType();
        if (!e) return undefined;
        kids.push(e);
        if (this.isSym(',')) { this.adv(); continue; }
        break;
      }
      if (!this.isSym(']')) return undefined;
      this.adv();
      return this.node('tuple-type', '', first, kids);
    }
    if (!(first.kind === 'id' || (first.kind === 'kw' && first.text === 'dynamic'))) return undefined;
    this.adv();
    let name = first.text;
    while (this.isSym('.') && this.isNameTok(1) && this.peek(1).kind === 'id') {
      this.adv();
      name += '.' + this.adv().text;
    }
    const args: Node[] = [];
    if (this.isSym('<')) {
      const save = this.i;
      this.adv();
      let ok = true;
      for (;;) {
        if (this.isSym('?')) { const q = this.adv(); args.push(mk('type', '?', q.start, q.end, q.line, q.col)); }
        else {
          const a = this.parseType();
          if (!a) { ok = false; break; }
          args.push(a);
        }
        if (this.isSym(',')) { this.adv(); continue; }
        break;
      }
      if (ok && this.isSym('>')) this.adv();
      else { this.i = save; args.length = 0; }
    }
    const n = this.node('type', name, first, args);
    n.nameStart = first.start; n.nameEnd = first.end;
    return n;
  }

  parseRequiredType(message: string): Node {
    const t = this.parseType();
    if (t) return t;
    this.error(message);
    const k = this.cur;
    return mk('type', '', k.start, k.start, k.line, k.col);
  }

  // ---- members / declarations --------------------------------------------
  /** One member or top-level element. `owner` = enclosing type name (for constructors). */
  parseMember(owner: string | null, topLevel: boolean): Node | null {
    const annos: Node[] = [];
    this.parseAnnotations(annos);
    const mods = this.parseModifiers(annos);
    const first = this.cur;
    const attach = (n: Node): Node => {
      n.children.unshift(mods);
      n.children.unshift(...annos);
      if (annos.length) { n.start = Math.min(n.start, annos[0].start); n.line = annos[0].line; n.col = annos[0].col; }
      if (mods.children.length) { n.start = Math.min(n.start, mods.start); }
      return n;
    };

    if (topLevel && this.isKw('package')) return this.parsePackage();
    if (topLevel && this.isKw('use')) return this.parseUse();
    if (this.isKw('class')) return attach(this.parseClass('class'));
    if (this.isKw('interface')) return attach(this.parseInterface());
    if (this.isKw('enum')) return attach(this.parseEnum());
    if (this.isKw('record')) return attach(this.parseRecord());
    if (this.isKw('exception')) return attach(this.parseException());
    if (this.isKw('macro')) return attach(this.parseMacro());
    if (this.isKw('method')) return attach(this.parseMethod());
    if (this.isWord('data') && this.isKw('class', 1)) { this.adv(); return attach(this.parseClass('data-class')); }

    // constructor: Name(params) [: super(...)] block
    if (owner !== null && this.cur.kind === 'id' && this.cur.text.toLowerCase() === owner.toLowerCase() && this.isSym('(', 1)) {
      return attach(this.parseConstructor());
    }
    // variable: [final] var name = expr
    if (this.isKw('var')) {
      const v = this.adv();
      const name = this.cur;
      if (!this.isNameTok()) { this.error('Expected variable name after var'); return attach(this.node('variable', '', v)); }
      this.adv();
      const n = this.node('variable', name.text, first, [mk('type', 'var', v.start, v.end, v.line, v.col)]);
      n.nameStart = name.start; n.nameEnd = name.end;
      if (this.isSym('=')) { this.adv(); n.children.push(this.parseInit()); n.end = this.prev.end; }
      this.eatSemi();
      return attach(n);
    }
    // property / field: Type name [{ get, set }] [= init]
    const save = this.i;
    const ty = this.tryType();
    if (ty && this.isNameTok() && !(this.cur.kind === 'kw' && CONTROL.has(this.cur.text))) {
      const name = this.adv();
      const accessors = this.isSym('{') ? this.parseAccessors() : undefined;
      const n = this.node(accessors ? 'property' : 'field', name.text, first, [ty]);
      n.nameStart = name.start; n.nameEnd = name.end;
      if (accessors) n.children.push(accessors);
      if (this.isSym('=')) { this.adv(); n.children.push(this.parseInit()); }
      n.end = this.prev.end;
      this.eatSemi();
      return attach(n);
    }
    this.i = save;
    if (mods.children.length || annos.length) {
      this.error('Expected declaration after modifiers');
      return null;
    }
    if (topLevel) {
      // loose statements at top level are not valid, but report and recover
      this.error(`Unexpected '${this.cur.text}' at top level`);
      this.syncTopLevel();
      return null;
    }
    this.error(`Unexpected '${this.cur.text}' in class body`);
    this.syncMember();
    return null;
  }

  syncTopLevel() {
    this.adv();
    while (!this.eof()) {
      const k = this.cur;
      if (k.nl && (k.kind === 'kw' && (TYPE_DECL.has(k.text) || k.text === 'method' || k.text === 'package' || k.text === 'use') || MODIFIERS.has(k.text) || this.isSym('@'))) return;
      this.adv();
    }
  }
  syncMember() {
    if (!this.isSym('}')) this.adv();
    while (!this.eof() && !this.isSym('}')) {
      const k = this.cur;
      if (k.nl && (k.kind === 'kw' || this.isSym('@'))) return;
      this.adv();
    }
  }

  eatSemi() { if (this.isSym(';')) this.adv(); }

  parsePackage(): Node {
    const kw = this.adv();
    const q = this.parseQualified('Expected package name');
    const n = this.node('package', q, kw);
    this.eatSemi();
    return n;
  }

  parseQualified(message: string): string {
    if (!this.isNameTok()) { this.error(message); return ''; }
    let s = this.adv().text;
    while (this.isSym('.') && this.isNameTok(1)) { this.adv(); s += '.' + this.adv().text; }
    return s;
  }

  /** use { a.b.[X, Y as Z], c.D } | use a.b.C [as D] */
  parseUse(): Node {
    const kw = this.adv();
    const use = this.node('use', '', kw);
    if (this.isSym('{')) {
      this.adv();
      while (!this.eof() && !this.isSym('}')) {
        const before = this.i;
        this.parseUseEntry(use);
        if (this.isSym(',')) this.adv();
        if (this.i === before) { this.error(`Unexpected '${this.cur.text}' in use block`); this.adv(); }
      }
      this.expect('}', "Expected '}' after use block");
    } else {
      this.parseUseEntry(use);
    }
    use.end = this.prev.end;
    this.eatSemi();
    return use;
  }

  parseUseEntry(use: Node) {
    if (!this.isNameTok()) { this.error('Expected name in use declaration'); return; }
    const first = this.cur;
    let path = this.adv().text;
    let startOffset = first.start;
    for (;;) {
      if (this.isSym('.') && this.isSym('[', 1)) {
        this.adv(); this.adv();
        const prefix = path;
        while (!this.eof() && !this.isSym(']')) {
          if (!this.isNameTok()) { this.error('Expected name in use group'); this.adv(); continue; }
          const it = this.adv();
          const item = mk('use-item', `${prefix}.${it.text}`, it.start, it.end, it.line, it.col);
          item.nameStart = startOffset; item.nameEnd = it.end;
          if (this.isWord('as')) {
            this.adv();
            if (this.isNameTok()) {
              const al = this.adv();
              const a = mk('alias', al.text, al.start, al.end, al.line, al.col);
              item.children.push(a);
              item.end = al.end;
            }
          }
          use.children.push(item);
          if (this.isSym(',')) this.adv();
        }
        this.expect(']', "Expected ']' after use group");
        return;
      }
      if (this.isSym('.') && this.isNameTok(1)) { this.adv(); path += '.' + this.adv().text; continue; }
      break;
    }
    const item = mk('use-item', path, first.start, this.prev.end, first.line, first.col);
    item.nameStart = first.start; item.nameEnd = this.prev.end;
    if (this.isWord('as')) {
      this.adv();
      if (this.isNameTok()) {
        const al = this.adv();
        item.children.push(mk('alias', al.text, al.start, al.end, al.line, al.col));
        item.end = al.end;
      } else this.error('Expected alias name after as');
    }
    use.children.push(item);
  }

  // where T, U: A & B
  parseWhere(): Node | undefined {
    if (!this.isWord('where')) return undefined;
    const kw = this.adv();
    const w = this.node('where', '', kw);
    for (;;) {
      if (!this.isNameTok()) { this.error('Expected type parameter name'); break; }
      const nm = this.adv();
      const tp = mk('typeparam', nm.text, nm.start, nm.end, nm.line, nm.col);
      tp.nameStart = nm.start; tp.nameEnd = nm.end;
      if (this.isSym(':')) {
        this.adv();
        for (;;) {
          const b = this.parseRequiredType('Expected bound type');
          tp.children.push(b);
          if (this.isSym('&')) { this.adv(); continue; }
          break;
        }
        tp.end = this.prev.end;
      }
      w.children.push(tp);
      if (this.isSym(',') ) { this.adv(); continue; }
      break;
    }
    w.end = this.prev.end;
    return w;
  }

  parseTypeList(kind: string): Node {
    const kw = this.adv();
    const n = this.node(kind, '', kw);
    for (;;) {
      n.children.push(this.parseRequiredType(`Expected type after '${kw.text}'`));
      if (this.isSym(',')) { this.adv(); continue; }
      break;
    }
    n.end = this.prev.end;
    return n;
  }

  /** where / based / implements in any order */
  parseHeaderClauses(into: Node[]) {
    for (;;) {
      if (this.isWord('where')) { const w = this.parseWhere(); if (w) into.push(w); continue; }
      if (this.isWord('based') && !this.cur.nl) { into.push(this.parseTypeList('based')); continue; }
      if (this.isWord('implements') && !this.cur.nl) { into.push(this.parseTypeList('implements')); continue; }
      // clauses may continue on the next line
      if (this.cur.nl && (this.isWord('where') || this.isWord('based') || this.isWord('implements'))) continue;
      break;
    }
  }

  parseName(kindLabel: string): Token | null {
    if (this.isNameTok() && !this.isSym('{')) return this.adv();
    this.error(`Expected ${kindLabel} name`);
    return null;
  }

  parseBody(owner: string): Node {
    const open = this.cur;
    const body = mk('body', '', open.start, open.end, open.line, open.col, []);
    if (!this.expect('{', "Expected '{'")) return body;
    while (!this.eof() && !this.isSym('}')) {
      const before = this.i;
      const m = this.parseMember(owner, false);
      if (m) body.children.push(m);
      if (this.i === before) this.adv();
    }
    this.expect('}', "Expected '}' after class body");
    body.end = this.prev.end;
    return body;
  }

  parseClass(kind: 'class' | 'data-class'): Node {
    const kw = this.adv();
    const name = this.parseName('class');
    const n = this.node(kind, name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    if (kind === 'data-class') n.children.push(this.parseParams());
    this.parseHeaderClauses(n.children);
    if (this.isSym('{')) n.children.push(this.parseBody(n.text));
    else if (kind === 'class') this.error("Expected '{' after class header");
    n.end = this.prev.end;
    return n;
  }

  parseRecord(): Node {
    const kw = this.adv();
    const name = this.parseName('record');
    const n = this.node('record', name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    n.children.push(this.parseParams());
    this.parseHeaderClauses(n.children);
    if (this.isSym('{')) n.children.push(this.parseBody(n.text));
    n.end = this.prev.end;
    return n;
  }

  parseInterface(): Node {
    const kw = this.adv();
    const name = this.parseName('interface');
    const n = this.node('interface', name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    this.parseHeaderClauses(n.children);
    if (this.isSym('{')) n.children.push(this.parseBody(n.text));
    else this.error("Expected '{' after interface header");
    n.end = this.prev.end;
    return n;
  }

  parseException(): Node {
    const kw = this.adv();
    const name = this.parseName('exception');
    const n = this.node('exception', name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    if (this.isSym('(') && !this.cur.nl) n.children.push(this.parseParams());
    this.parseHeaderClauses(n.children);
    if (this.isSym('{')) n.children.push(this.parseBody(n.text));
    n.end = this.prev.end;
    return n;
  }

  parseEnum(): Node {
    const kw = this.adv();
    const name = this.parseName('enum');
    const n = this.node('enum', name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    this.parseHeaderClauses(n.children);
    const open = this.cur;
    const body = mk('body', '', open.start, open.end, open.line, open.col, []);
    if (this.expect('{', "Expected '{' after enum name")) {
      // entries up to ';' or '}'
      while (!this.eof() && !this.isSym('}') && !this.isSym(';')) {
        if (this.isSym('@')) { const a: Node[] = []; this.parseAnnotations(a); }
        if (!this.isNameTok()) { this.error('Expected enum entry name'); this.adv(); continue; }
        const e = this.adv();
        const entry = mk('enum-entry', e.text, e.start, e.end, e.line, e.col);
        entry.nameStart = e.start; entry.nameEnd = e.end;
        if (this.isSym('(')) { this.adv(); entry.children.push(...this.parseArgsUntil(')', "Expected ')' after enum entry arguments")); entry.end = this.prev.end; }
        body.children.push(entry);
        if (this.isSym(',')) this.adv();
        else break;
      }
      if (this.isSym(';')) {
        this.adv();
        while (!this.eof() && !this.isSym('}')) {
          const before = this.i;
          const m = this.parseMember(n.text, false);
          if (m) body.children.push(m);
          if (this.i === before) this.adv();
        }
      }
      this.expect('}', "Expected '}' after enum body");
    }
    body.end = this.prev.end;
    n.children.push(body);
    n.end = this.prev.end;
    return n;
  }

  parseMacro(): Node {
    const kw = this.adv();
    const name = this.parseName('macro');
    const n = this.node('macro', name?.text ?? '', kw);
    if (name) { n.nameStart = name.start; n.nameEnd = name.end; }
    n.children.push(this.parseParams());
    const targets = mk('targets', '', this.cur.start, this.cur.start, this.cur.line, this.cur.col, []);
    if (this.isWord('on')) {
      this.adv();
      for (;;) {
        if (!this.isNameTok()) { this.error('Expected macro target'); break; }
        const t = this.adv();
        targets.children.push(mk('target', t.text, t.start, t.end, t.line, t.col));
        if (this.isSym(',')) { this.adv(); continue; }
        break;
      }
      targets.end = this.prev.end;
    } else this.error("Expected 'on' after macro parameters");
    n.children.push(targets);
    n.children.push(this.parseBlock());
    n.end = this.prev.end;
    return n;
  }

  parseParams(): Node {
    const first = this.cur;
    const params = mk('params', '', first.start, first.start, first.line, first.col, []);
    if (!this.isSym('(')) return params;
    this.adv();
    while (!this.eof() && !this.isSym(')')) {
      const before = this.i;
      const annos: Node[] = [];
      this.parseAnnotations(annos);
      const mods = this.parseModifiers(annos);
      const ty = this.parseType();
      if (!ty) { this.error('Expected parameter type'); break; }
      if (!this.isNameTok()) { this.error('Expected parameter name'); break; }
      const nm = this.adv();
      const p = mk('param', nm.text, ty.start, nm.end, ty.line, ty.col, [...annos, mods, ty]);
      p.nameStart = nm.start; p.nameEnd = nm.end;
      if (this.isSym('=')) { this.adv(); p.children.push(this.parseExpression()); p.end = this.prev.end; }
      params.children.push(p);
      if (this.isSym(',')) { this.adv(); continue; }
      if (this.i === before) this.adv();
      break;
    }
    this.expect(')', "Expected ')' after parameter list");
    params.end = this.prev.end;
    return params;
  }

  parseAccessors(): Node {
    const open = this.adv(); // {
    const acc = mk('accessors', '', open.start, open.end, open.line, open.col, []);
    while (!this.eof() && !this.isSym('}')) {
      let mod = '';
      if (this.cur.kind === 'kw' && MODIFIERS.has(this.cur.text)) mod = this.adv().text + ' ';
      if (this.isWord('get') || this.isWord('set')) {
        const k = this.adv();
        acc.children.push(mk('accessor', mod + k.text, k.start, k.end, k.line, k.col));
      } else { this.error("Expected 'get' or 'set'"); this.adv(); }
      if (this.isSym(',')) this.adv();
    }
    this.expect('}', "Expected '}' after accessors");
    acc.end = this.prev.end;
    return acc;
  }

  parseMethod(): Node {
    const kw = this.adv();
    const n = this.node('method', '', kw);
    if (this.isSym('<')) {
      this.adv();
      n.children.push(Object.assign(this.parseRequiredType('Expected return type'), { kind: 'type' }));
      n.children[n.children.length - 1].kind = 'return-type' as string;
      this.expect('>', "Expected '>' after return type");
    }
    const name = this.parseName('method');
    if (name) { n.text = name.text; n.nameStart = name.start; n.nameEnd = name.end; }
    n.children.push(this.parseParams());
    this.parseHeaderClauses(n.children);
    if (this.isSym('{')) {
      n.children.push(this.parseBlock());
    }
    n.end = this.prev.end;
    return n;
  }

  parseConstructor(): Node {
    const name = this.adv();
    const n = this.node('constructor', name.text, name);
    n.nameStart = name.start; n.nameEnd = name.end;
    n.children.push(this.parseParams());
    if (this.isSym(':')) {
      this.adv();
      if (this.isKw('super') || this.isKw('this')) {
        const k = this.adv();
        const sc = this.node('super-call', k.text, k);
        if (this.isSym('(')) { this.adv(); sc.children.push(...this.parseArgsUntil(')', "Expected ')' after arguments")); }
        sc.end = this.prev.end;
        n.children.push(sc);
      } else this.error("Expected 'super' or 'this' after ':'");
    }
    n.children.push(this.parseBlock());
    n.end = this.prev.end;
    return n;
  }

  /** `= expr` with optional trailing cascade */
  parseInit(): Node {
    return this.parseExpression();
  }

  // ---- statements ---------------------------------------------------------
  parseBlock(): Node {
    const open = this.cur;
    const block = mk('block', '', open.start, open.end, open.line, open.col, []);
    if (!this.expect('{', "Expected '{' before block")) return block;
    // placeholder body: { ... }
    if (this.isSym('...') && this.isSym('}', 1)) {
      const p = this.adv();
      block.children.push(mk('placeholder', '...', p.start, p.end, p.line, p.col));
      this.adv();
      block.end = this.prev.end;
      block.kind = 'block';
      return block;
    }
    while (!this.eof() && !this.isSym('}')) {
      const before = this.i;
      const s = this.parseStatement();
      if (s) block.children.push(s);
      if (this.i === before) this.adv();
    }
    this.expect('}', "Expected '}' after block");
    block.end = this.prev.end;
    return block;
  }

  /** Control-flow body: braces are mandatory; reported but parsed as one statement. */
  parseBody2(what: string): Node {
    if (this.isSym('{')) return this.parseBlock();
    this.error(`braces are required after the condition of '${what}'`);
    const first = this.cur;
    const s = this.parseStatement();
    const b = mk('block', '', first.start, this.prev.end, first.line, first.col, s ? [s] : []);
    return b;
  }

  parseStatement(): Node | null {
    const k = this.cur;
    if (this.isSym(';')) { this.adv(); return null; }
    if (this.isSym('{')) return this.parseBlock();
    if (this.isSym('...')) { const p = this.adv(); this.eatSemi(); return this.node('placeholder', '...', p); }

    if (k.kind === 'kw') {
      switch (k.text) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'switch': { const s = this.parseSwitch(); this.eatSemi(); return s; }
        case 'return': {
          this.adv();
          const n = this.node('return', '', k);
          if (!this.cur.nl && !this.isSym('}') && !this.isSym(';') && !this.eof()) n.children.push(this.parseExpression());
          n.end = this.prev.end;
          this.eatSemi();
          return n;
        }
        case 'fail': {
          this.adv();
          const n = this.node('fail', '', k, [this.parseExpression()]);
          this.eatSemi();
          return n;
        }
        case 'break': case 'continue': { this.adv(); this.eatSemi(); return this.node(k.text, '', k); }
        default: break;
      }
    }
    if (k.kind === 'id' && k.text === 'success' && !this.isSym('=', 1) && !this.isSym('.', 1) && !this.isSym('..', 1) && !(this.peek(1).nl) && !this.eof()) {
      this.adv();
      const n = this.node('success', '', k, [this.parseExpression()]);
      this.eatSemi();
      return n;
    }

    // local declarations
    const decl = this.tryLocalDeclaration();
    if (decl) { this.eatSemi(); return decl; }

    // expression statement (cascade, assignment, call ...)
    const before = this.i;
    const e = this.parseExpression();
    const n = this.node('expr-stmt', '', k, [e]);
    if (this.i === before) return null;
    this.eatSemi();
    return n;
  }

  /** `final|scoped var x = e`, `var { a, _ } = e`, `Type name [= e]`, `dynamic x = e` */
  tryLocalDeclaration(): Node | null {
    const first = this.cur;
    const save = this.i;
    const mods: Node[] = [];
    while (this.cur.kind === 'kw' && (this.cur.text === 'final' || this.cur.text === 'scoped')) {
      const m = this.adv();
      mods.push(mk('modifier', m.text, m.start, m.end, m.line, m.col));
    }
    // destructuring / inferred
    if (this.isKw('var')) {
      const v = this.adv();
      if (this.isSym('{')) return this.parseDestructure(first, mods);
      if (this.isNameTok() && !this.isReservedNameStart()) {
        const name = this.adv();
        const n = this.node('local', name.text, first, [...mods, mk('type', 'var', v.start, v.end, v.line, v.col)]);
        n.nameStart = name.start; n.nameEnd = name.end;
        if (this.isSym('=')) { this.adv(); n.children.push(this.parseInit()); n.end = this.prev.end; }
        return n;
      }
      this.i = save;
      return null;
    }
    // `Type name` — speculative
    const ty = this.tryType();
    if (ty && this.isNameTok()) {
      const nameTok = this.cur;
      const nextIsDeclEnd = this.isSym('=', 1) || this.isSym(';', 1) || this.peek(1).nl || this.isWord('in', 1) || this.peek(1).kind === 'eof' || this.isSym('}', 1);
      const nameOk = nameTok.kind === 'id' || (nameTok.kind === 'kw' && !CONTROL.has(nameTok.text) && !TYPE_DECL.has(nameTok.text) ? true : (nameTok.kind === 'kw' && (TYPE_DECL.has(nameTok.text) || nameTok.text === 'method') && nextIsDeclEnd));
      if (nameOk && !(nameTok.kind === 'kw' && ['is', 'as', 'in'].includes(nameTok.text))) {
        this.adv();
        const n = this.node('local', nameTok.text, first, [...mods, ty]);
        n.nameStart = nameTok.start; n.nameEnd = nameTok.end;
        if (this.isSym('=')) { this.adv(); n.children.push(this.parseInit()); n.end = this.prev.end; }
        return n;
      }
    }
    this.i = save;
    return null;
  }

  isReservedNameStart(): boolean {
    const k = this.cur;
    return k.kind === 'kw' && (CONTROL.has(k.text));
  }

  parseDestructure(first: Token, mods: Node[]): Node {
    this.adv(); // {
    const n = this.node('destructure', '', first, [...mods]);
    while (!this.eof() && !this.isSym('}')) {
      if (this.isNameTok()) {
        const t = this.adv();
        if (t.text === '_') n.children.push(mk('wildcard', '_', t.start, t.end, t.line, t.col));
        else { const b = mk('binding', t.text, t.start, t.end, t.line, t.col); b.nameStart = t.start; b.nameEnd = t.end; n.children.push(b); }
      } else { this.error('Expected name in destructuring'); this.adv(); }
      if (this.isSym(',')) this.adv();
    }
    this.expect('}', "Expected '}' in destructuring");
    if (this.isSym('=')) { this.adv(); n.children.push(this.parseExpression()); }
    else this.error("Expected '=' in destructuring");
    n.end = this.prev.end;
    return n;
  }

  parseCondition(what: string): Node {
    let hadParen = false;
    if (this.isSym('(')) { hadParen = true; this.adv(); }
    else this.error("Expected '(' before condition");
    const e = this.parseExpression();
    if (hadParen) this.expect(')', `Expected ')' after condition`);
    else if (this.isSym(')')) this.adv();
    void what;
    return e;
  }

  parseIf(): Node {
    const kw = this.adv();
    const cond = this.parseCondition('if');
    const body = this.parseBody2('if');
    const n = this.node('if', '', kw, [cond, body]);
    if (this.isWord('else') && this.cur.kind === 'id') {
      const el = this.adv();
      this.error("'else' is not supported; use guard clauses (return early)", el);
      let eb: Node;
      if (this.isKw('if')) eb = this.parseIf();
      else eb = this.parseBody2('else');
      n.children.push(mk('else', '', el.start, this.prev.end, el.line, el.col, [eb]));
      n.end = this.prev.end;
    }
    return n;
  }

  parseWhile(): Node {
    const kw = this.adv();
    const cond = this.parseCondition('while');
    const body = this.parseBody2('while');
    return this.node('while', '', kw, [cond, body]);
  }

  parseFor(): Node {
    const kw = this.adv();
    if (!this.expect('(', "Expected '(' after for")) { /* continue */ }
    // foreach: [final] (Type | var) name in expr
    const save = this.i;
    let isForeach = false;
    {
      this.silent++;
      if (this.isKw('final')) this.adv();
      if (this.isKw('var')) this.adv();
      else this.parseType();
      if (this.isNameTok()) { this.adv(); if (this.isKw('in')) isForeach = true; }
      this.silent--;
      this.i = save;
    }
    if (isForeach) {
      const mods: Node[] = [];
      if (this.isKw('final')) { const m = this.adv(); mods.push(mk('modifier', 'final', m.start, m.end, m.line, m.col)); }
      let ty: Node;
      if (this.isKw('var')) { const v = this.adv(); ty = mk('type', 'var', v.start, v.end, v.line, v.col); }
      else ty = this.parseRequiredType('Expected loop variable type');
      const name = this.adv();
      this.adv(); // in
      const iter = this.parseExpression();
      this.expect(')', "Expected ')' after for iterable");
      const body = this.parseBody2('for');
      const n = this.node('foreach', name.text, kw, [...mods, ty, iter, body]);
      n.nameStart = name.start; n.nameEnd = name.end;
      return n;
    }
    // classic: init; cond; update
    const init = mk('init', '', this.cur.start, this.cur.start, this.cur.line, this.cur.col, []);
    if (!this.isSym(';')) {
      const d = this.tryLocalDeclaration();
      if (d) init.children.push(d);
      else init.children.push(this.parseExpression());
      init.end = this.prev.end;
    }
    this.expect(';', "Expected ';' after for initializer");
    const cond = mk('condition', '', this.cur.start, this.cur.start, this.cur.line, this.cur.col, []);
    if (!this.isSym(';')) { cond.children.push(this.parseExpression()); cond.end = this.prev.end; }
    this.expect(';', "Expected ';' after for condition");
    const upd = mk('update', '', this.cur.start, this.cur.start, this.cur.line, this.cur.col, []);
    while (!this.eof() && !this.isSym(')')) {
      const before = this.i;
      upd.children.push(this.parseExpression());
      if (this.isSym(',')) { this.adv(); continue; }
      if (this.i === before) this.adv();
      break;
    }
    upd.end = this.prev.end;
    this.expect(')', "Expected ')' after for clauses");
    const body = this.parseBody2('for');
    return this.node('for', '', kw, [init, cond, upd, body]);
  }

  // ---- switch (statement + expression) -----------------------------------
  parseSwitch(): Node {
    const kw = this.adv();
    const n = this.node('switch', '', kw);
    this.expect('(', "Expected '(' after switch");
    n.children.push(this.parseExpression());
    this.expect(')', "Expected ')' after switch subject");
    if (!this.expect('{', "Expected '{' before switch cases")) { n.end = this.prev.end; return n; }
    while (!this.eof() && !this.isSym('}')) {
      const before = this.i;
      n.children.push(this.parseCase());
      if (this.isSym(',') || this.isSym(';')) this.adv();
      if (this.i === before) this.adv();
    }
    this.expect('}', "Expected '}' after switch");
    n.end = this.prev.end;
    return n;
  }

  parseCase(): Node {
    const first = this.cur;
    const c = mk('case', '', first.start, first.end, first.line, first.col, []);
    for (;;) {
      c.children.push(this.parsePattern());
      if (this.isSym(',')) { this.adv(); continue; }
      break;
    }
    if (!this.expect('->', "Expected '->' after switch pattern")) {
      // recover: skip to end of line
      while (!this.eof() && !this.cur.nl && !this.isSym('}')) this.adv();
      c.end = this.prev.end;
      return c;
    }
    c.children.push(this.parseCaseBody());
    c.end = this.prev.end;
    return c;
  }

  parseCaseBody(): Node {
    const k = this.cur;
    if (this.isSym('{')) return this.parseBlock();
    if (k.kind === 'kw' && (k.text === 'return' || k.text === 'fail' || k.text === 'break' || k.text === 'continue')) {
      const s = this.parseStatement();
      return s ?? mk('block', '', k.start, k.end, k.line, k.col);
    }
    if (k.kind === 'id' && k.text === 'success' && !this.isSym('(', 1) && !this.isSym('=', 1) && !this.isSym('.', 1)) {
      this.adv();
      return this.node('success', '', k, [this.parseExpression()]);
    }
    return this.parseExpression();
  }

  parsePattern(): Node {
    const k = this.cur;
    // success / success(x) / success(_)
    if (k.kind === 'id' && (k.text === 'success' || k.text === 'error')) {
      this.adv();
      const p = this.node(k.text === 'success' ? 'pattern-success' : 'pattern-error', '', k);
      if (this.isSym('(')) {
        this.adv();
        // error(Type e) | error(e) | error(_)
        const save = this.i;
        let ty: Node | undefined;
        if (k.text === 'error') {
          this.silent++;
          const t0 = this.tryType();
          this.silent--;
          if (t0 && this.isNameTok()) ty = t0; else this.i = save;
        }
        if (ty) p.children.push(ty);
        if (this.isNameTok()) {
          const b = this.adv();
          if (b.text === '_') p.children.push(mk('wildcard', '_', b.start, b.end, b.line, b.col));
          else { const bn = mk('binding', b.text, b.start, b.end, b.line, b.col); bn.nameStart = b.start; bn.nameEnd = b.end; p.children.push(bn); }
        } else this.error('Expected binding name in pattern');
        this.expect(')', "Expected ')' after pattern");
      }
      p.end = this.prev.end;
      return p;
    }
    // literal pattern
    if (k.kind === 'string' || k.kind === 'int' || k.kind === 'float' || (k.kind === 'kw' && (k.text === 'true' || k.text === 'false' || k.text === 'null')) || this.isSym('-')) {
      const e = this.parseBinary(8); // above comparison, so '->' stays
      return this.node('pattern-value', '', k, [e]);
    }
    if (this.isNameTok()) {
      let name = this.adv().text;
      while (this.isSym('.') && this.isNameTok(1)) { this.adv(); name += '.' + this.adv().text; }
      const p = this.node('pattern-name', name, k);
      p.nameStart = k.start; p.nameEnd = this.prev.end;
      return p;
    }
    this.error('Expected switch pattern');
    return this.node('pattern-name', '', k);
  }

  // ---- expressions --------------------------------------------------------
  parseExpression(): Node {
    return this.parseAssignment();
  }

  parseAssignment(): Node {
    const first = this.cur;
    const left = this.parseTernary();
    const k = this.cur;
    if (k.kind === 'sym' && (k.text === '=' || k.text === '+=' || k.text === '-=' || k.text === '*=' || k.text === '/=' || k.text === '%=')) {
      this.adv();
      const right = this.parseAssignment();
      const a = this.node('assign', k.text, first, [left, right]);
      // `..` after the value starts the next cascade section — handled by the cascade loop of the receiver
      return a;
    }
    return left;
  }

  /** Is the `?` at offset `o` (relative) a ternary operator (vs result propagation)? */
  isTernaryAt(o: number): boolean {
    const q = this.peek(o);
    const nx = this.peek(o + 1);
    const atLineEnd = nx.kind === 'eof' || nx.nl;
    if (!atLineEnd) {
      // something follows on the same line: ternary iff an expression can start there
      if (nx.kind === 'id' || nx.kind === 'int' || nx.kind === 'float' || nx.kind === 'string') return true;
      if (nx.kind === 'kw') return ['true', 'false', 'null', 'this', 'super', 'switch', 'fiber', 'virtual', 'thread', 'dynamic'].includes(nx.text);
      return nx.text === '(' || nx.text === '[' || nx.text === '{' || nx.text === '!' || nx.text === '-' || nx.text === '+' || nx.text === '++' || nx.text === '--' || nx.text === '$';
    }
    // `?` at line end: ternary only if a ':' follows at bracket depth 0 within 3 lines
    let depth = 0;
    for (let j = o + 1; ; j++) {
      const t = this.peek(j);
      if (t.kind === 'eof' || t.line > q.line + 3) return false;
      if (t.kind === 'sym') {
        if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') { depth--; if (depth < 0) return false; }
        else if (depth === 0) {
          if (t.text === ':') return true;
          if (t.text === '?' || t.text === ';' || t.text === '->' || t.text === '=') return false;
        }
      }
    }
  }

  parseTernary(): Node {
    const first = this.cur;
    const cond = this.parseBinary(0);
    if (this.isSym('?') && this.isTernaryAt(0)) {
      this.adv();
      const a = this.parseTernary();
      if (this.isSym(':')) this.adv();
      else this.error("Expected ':' in conditional expression");
      const b = this.parseTernary();
      return this.node('ternary', '', first, [cond, a, b]);
    }
    return cond;
  }

  // precedence levels: 0 ||, 1 &&, 2 == !=, 3 < <= > >= is as, 4 + -, 5 * / %
  private levels: string[][] = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];

  parseBinary(level: number): Node {
    if (level >= this.levels.length) return this.parseUnary();
    const first = this.cur;
    let left = this.parseBinary(level + 1);
    for (;;) {
      const k = this.cur;
      if (level === 3 && k.kind === 'kw' && (k.text === 'is' || k.text === 'as')) {
        this.adv();
        const ty = this.parseRequiredType(`Expected type after '${k.text}'`);
        left = this.node(k.text, '', first, [left, ty]);
        continue;
      }
      if (k.kind === 'sym' && this.levels[level].includes(k.text)) {
        // `a < b` vs generic: handled in primary; `-`/`+` at line start continue the expression (leading-operator style)
        this.adv();
        const right = this.parseBinary(level + 1);
        left = this.node('binary', k.text, first, [left, right]);
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary(): Node {
    const k = this.cur;
    if (k.kind === 'sym' && (k.text === '!' || k.text === '-' || k.text === '+' || k.text === '++' || k.text === '--')) {
      this.adv();
      const e = this.parseUnary();
      return this.node('unary', k.text, k, [e]);
    }
    return this.parsePostfix();
  }

  parsePostfix(): Node {
    const first = this.cur;
    let e = this.parsePrimary();
    let hasCascade = false;
    const sections: Node[] = [];
    for (;;) {
      const k = this.cur;
      if (k.kind !== 'sym') break;
      if (k.text === '.' ) {
        const dot = this.adv();
        if (!this.isNameTok()) {
          this.error("Expected member name after '.'", dot);
          e = this.node('error', '', first, [e]);
          break;
        }
        const nm = this.adv();
        e = this.node('member', nm.text, first, [e]);
        e.nameStart = nm.start; e.nameEnd = nm.end;
        continue;
      }
      if (k.text === '(' && !k.nl) {
        this.adv();
        const args = this.parseArgsUntil(')', "Expected ')' after arguments");
        e = this.node('call', '', first, [e, ...args]);
        continue;
      }
      if (k.text === '[' && !k.nl) {
        this.adv();
        const idx = this.parseExpression();
        this.expect(']', "Expected ']' after index");
        e = this.node('index', '', first, [e, idx]);
        continue;
      }
      if (k.text === '?' && !this.isTernaryAt(0)) {
        this.adv();
        e = this.node('propagate', '', first, [e]);
        continue;
      }
      if (k.text === '!' && !k.nl && this.postfixBang()) {
        this.adv();
        e = this.node('unwrap', '', first, [e]);
        continue;
      }
      if ((k.text === '++' || k.text === '--') && !k.nl) {
        this.adv();
        e = this.node('postfix', k.text, first, [e]);
        continue;
      }
      if (k.text === '..' ) {
        // cascade section: receiver ..a() ..x = 1
        hasCascade = true;
        this.adv();
        const sFirst = this.cur;
        let chain: Node;
        if (!this.isNameTok()) { this.error("Expected member name after '..'"); break; }
        const nm = this.adv();
        chain = this.node('member', nm.text, sFirst, []);
        chain.nameStart = nm.start; chain.nameEnd = nm.end;
        for (;;) {
          const c = this.cur;
          if (c.kind === 'sym' && c.text === '.' ) {
            this.adv();
            if (!this.isNameTok()) { this.error("Expected member name after '.'", c); break; }
            const m = this.adv();
            chain = this.node('member', m.text, sFirst, [chain]);
            chain.nameStart = m.start; chain.nameEnd = m.end;
            continue;
          }
          if (c.kind === 'sym' && c.text === '(' && !c.nl) {
            this.adv();
            const args = this.parseArgsUntil(')', "Expected ')' after arguments");
            chain = this.node('call', '', sFirst, [chain, ...args]);
            continue;
          }
          if (c.kind === 'sym' && c.text === '[' && !c.nl) {
            this.adv();
            const idx = this.parseExpression();
            this.expect(']', "Expected ']' after index");
            chain = this.node('index', '', sFirst, [chain, idx]);
            continue;
          }
          break;
        }
        const a = this.cur;
        if (a.kind === 'sym' && ['=', '+=', '-=', '*=', '/=', '%='].includes(a.text)) {
          this.adv();
          const value = this.parseCascadeValue();
          chain = this.node('assign', a.text, sFirst, [chain, value]);
        }
        sections.push(mk('cascade-section', '', chain.start, chain.end, chain.line, chain.col, [chain]));
        continue;
      }
      break;
    }
    if (hasCascade) {
      return mk('cascade', '', e.start, this.prev.end, e.line, e.col, [e, ...sections]);
    }
    return e;
  }

  /** Value of `..x = value`: stops at the next `..` */
  parseCascadeValue(): Node {
    return this.parseTernary();
  }

  postfixBang(): boolean {
    // result! — only when no operand follows on the same line
    const nx = this.peek(1);
    if (nx.nl || nx.kind === 'eof') return true;
    return nx.kind === 'sym' && [')', ']', '}', ',', ';', '.', '..', '+', '-', '*', '/', '%', '==', '!=', '&&', '||', '?', ':', '<', '>', '<=', '>='].includes(nx.text);
  }

  parseArgsUntil(close: string, message: string): Node[] {
    const args: Node[] = [];
    while (!this.eof() && !this.isSym(close)) {
      const before = this.i;
      args.push(this.parseExpression());
      if (this.isSym(',')) { this.adv(); continue; }
      if (this.i === before) this.adv();
      break;
    }
    if (this.isSym(close)) this.adv();
    else this.error(message);
    return args;
  }

  parsePrimary(): Node {
    const k = this.cur;
    switch (k.kind) {
      case 'int': this.adv(); return this.node('int-literal', k.text, k);
      case 'float': this.adv(); return this.node('float-literal', k.text, k);
      case 'string': return this.parseString();
      default: break;
    }
    if (k.kind === 'kw') {
      switch (k.text) {
        case 'true': case 'false': this.adv(); return this.node('bool-literal', k.text, k);
        case 'null': this.adv(); return this.node('null-literal', 'null', k);
        case 'this': this.adv(); return this.node('this', 'this', k);
        case 'super': { this.adv(); const n = this.node('name', 'super', k); n.nameStart = k.start; n.nameEnd = k.end; return n; }
        case 'switch': return this.parseSwitch();
        case 'fiber': case 'virtual': case 'thread': {
          this.adv();
          const blk = this.parseBlock();
          return this.node('task', k.text, k, [blk]);
        }
        case 'dynamic': { this.adv(); const n = this.node('name', 'dynamic', k); n.nameStart = k.start; n.nameEnd = k.end; return n; }
        default: break;
      }
    }
    // declaration words (exception, method, record, ...) may be used as plain names in expressions
    if (k.kind === 'id' || (k.kind === 'kw' && NAME_LIKE.has(k.text))) {
      // quote kind { ... }
      if (k.kind === 'id' && k.text === 'quote' && this.isNameTok(1) && this.isSym('{', 2)) return this.parseQuote();
      // single-parameter lambda: x -> expr
      if (this.isSym('->', 1)) return this.parseLambda();
      this.adv();
      // generic call target: Tuple<Int, Int>(1, 2)
      if (this.isSym('<')) {
        const save = this.i;
        this.silent++;
        const targs: Node[] = [];
        let ok = false;
        this.adv();
        for (;;) {
          const a = this.parseType();
          if (!a) break;
          targs.push(a);
          if (this.isSym(',')) { this.adv(); continue; }
          if (this.isSym('>') && this.isSym('(', 1)) ok = true;
          break;
        }
        this.silent--;
        if (ok) {
          this.adv();
          const n = this.node('generic-ref', k.text, k, targs);
          n.nameStart = k.start; n.nameEnd = k.end;
          return n;
        }
        this.i = save;
      }
      const n = this.node('name', k.text, k);
      n.nameStart = k.start; n.nameEnd = k.end;
      return n;
    }
    if (this.isSym('$') && this.isSym('(', 1)) {
      this.adv(); this.adv();
      const e = this.parseExpression();
      this.expect(')', "Expected ')' after splice expression");
      return this.node('splice', '', k, [e]);
    }
    if (this.isSym('...')) { this.adv(); return this.node('placeholder', '...', k); }
    if (this.isSym('(')) {
      if (this.isLambdaStart()) return this.parseLambda();
      this.adv();
      const e = this.parseExpression();
      this.expect(')', "Expected ')' after expression");
      return this.node('paren', '', k, [e]);
    }
    if (this.isSym('[')) return this.parseListLiteral();
    if (this.isSym('{')) return this.parseDictLiteral();
    this.error('Expected expression');
    const err = this.node('error', '', k);
    // make progress on tokens that cannot continue anything useful
    if (!(this.isSym('}') || this.isSym(')') || this.isSym(']') || this.eof())) this.adv();
    return err;
  }

  isLambdaStart(): boolean {
    if (!this.isSym('(')) return false;
    let depth = 0;
    for (let j = 0; ; j++) {
      const t = this.peek(j);
      if (t.kind === 'eof') return false;
      if (t.kind === 'sym' && t.text === '(') depth++;
      if (t.kind === 'sym' && t.text === ')') {
        depth--;
        if (depth === 0) return this.isSym('->', j + 1);
      }
    }
  }

  parseLambda(): Node {
    const first = this.cur;
    const params = mk('params', '', first.start, first.start, first.line, first.col, []);
    if (this.isSym('(')) {
      this.adv();
      while (!this.eof() && !this.isSym(')')) {
        const before = this.i;
        // `Type name` or just `name`
        const save = this.i;
        const ty = this.tryType();
        let p: Node;
        if (ty && this.isNameTok()) {
          const nm = this.adv();
          p = mk('param', nm.text, ty.start, nm.end, ty.line, ty.col, [ty]);
          p.nameStart = nm.start; p.nameEnd = nm.end;
        } else {
          this.i = save;
          if (!this.isNameTok()) { this.error('Expected lambda parameter name'); break; }
          const nm = this.adv();
          p = mk('param', nm.text, nm.start, nm.end, nm.line, nm.col, []);
          p.nameStart = nm.start; p.nameEnd = nm.end;
        }
        params.children.push(p);
        if (this.isSym(',')) { this.adv(); continue; }
        if (this.i === before) this.adv();
        break;
      }
      this.expect(')', "Expected ')' after lambda parameters");
    } else {
      const nm = this.adv();
      const p = mk('param', nm.text, nm.start, nm.end, nm.line, nm.col, []);
      p.nameStart = nm.start; p.nameEnd = nm.end;
      params.children.push(p);
    }
    params.end = this.prev.end;
    this.expect('->', "Expected '->' after lambda parameters");
    const body = this.isSym('{') ? this.parseBlock() : this.parseExpression();
    return this.node('lambda', '', first, [params, body]);
  }

  parseListLiteral(): Node {
    const open = this.adv();
    const elems = this.parseArgsUntil(']', "Expected ']' after list literal");
    return this.node('list-literal', '', open, elems);
  }

  parseDictLiteral(): Node {
    const open = this.adv();
    const n = this.node('dict-literal', '', open);
    while (!this.eof() && !this.isSym('}')) {
      const before = this.i;
      let computed = false;
      let key: Node;
      if (this.isSym('[')) {
        computed = true;
        this.adv();
        key = this.parseExpression();
        this.expect(']', "Expected ']' after computed key");
      } else key = this.parseBinary(1);
      const e0 = key;
      if (!this.expect(':', "Expected ':' after dictionary key")) { /* continue */ }
      const value = this.parseExpression();
      n.children.push(mk('dict-entry', computed ? 'computed' : '', e0.start, value.end, e0.line, e0.col, [key, value]));
      if (this.isSym(',')) { this.adv(); continue; }
      if (this.i === before) this.adv();
      break;
    }
    this.expect('}', "Expected '}' after dictionary literal");
    n.end = this.prev.end;
    return n;
  }

  parseQuote(): Node {
    const q = this.adv();
    const kindTok = this.adv();
    const n = this.node('quote', kindTok.text, q);
    this.adv(); // {
    const kind = kindTok.text;
    if (kind === 'expression') {
      n.children.push(this.parseExpression());
    } else if (kind === 'statement') {
      while (!this.eof() && !this.isSym('}')) {
        const before = this.i;
        const s = this.parseStatement();
        if (s) n.children.push(s);
        if (this.i === before) this.adv();
      }
    } else if (kind === 'field' || kind === 'method' || kind === 'class') {
      while (!this.eof() && !this.isSym('}')) {
        const before = this.i;
        const m = this.parseMember(null, false);
        if (m) n.children.push(m);
        if (this.i === before) this.adv();
      }
    } else {
      this.error(`Unknown quote kind '${kind}'. Expected statement, expression, field, method or class`, kindTok);
      let depth = 1;
      while (!this.eof() && depth > 0) {
        if (this.isSym('{')) depth++;
        if (this.isSym('}')) { depth--; if (depth === 0) break; }
        this.adv();
      }
    }
    this.expect('}', "Expected '}' after quote");
    n.end = this.prev.end;
    return n;
  }

  /** String literal: children `interpolation` per parseable `${expr}` */
  parseString(): Node {
    const k = this.adv();
    const n = this.node('string', k.text, k);
    const body = k.text;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') { i++; continue; }
      if (body[i] === '$' && body[i + 1] === '{') {
        // find matching }
        let depth = 0;
        let j = i + 1;
        let inStr = false;
        for (; j < body.length; j++) {
          const c = body[j];
          if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) break; }
        }
        if (j >= body.length) break;
        const inner = body.slice(i + 2, j);
        const base = k.start + i + 2;
        const { tokens } = tokenize(inner);
        for (const t of tokens) {
          t.start += base; t.end += base;
          t.col = k.col + (t.start - k.start);
          t.line = k.line;
          t.nl = false;
        }
        const sub = new Parser(tokens, this.src);
        sub.silent = 1;
        const e = sub.parseExpression();
        if (sub.eof() || sub.cur.kind === 'eof') {
          n.children.push(mk('interpolation', '', base - 2, base + inner.length + 1, k.line, k.col + (base - 2 - k.start), [e]));
        }
        i = j;
      }
    }
    return n;
  }
}

export interface ParseResult {
  root: Node;
  tokens: Token[];
  diagnostics: Diag[];
  lineStarts: number[];
}

export function parse(text: string): ParseResult {
  const { tokens, errors } = tokenize(text);
  const p = new Parser(tokens, text);
  const root = p.parseFile();
  const diagnostics: Diag[] = errors.map(e => ({
    message: e.message, start: e.start, end: e.end, line: e.line, col: e.col, severity: 'error' as const,
  }));
  diagnostics.push(...p.diags);
  diagnostics.sort((a, b) => a.start - b.start);
  return { root, tokens, diagnostics, lineStarts: computeLineStarts(text) };
}

export function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - lineStarts[lo] };
}

export function positionToOffset(lineStarts: number[], textLength: number, line: number, character: number): number {
  if (line >= lineStarts.length) return textLength;
  return Math.min(lineStarts[line] + character, textLength);
}
