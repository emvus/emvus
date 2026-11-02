import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, InitializeParams, InitializeResult,
  CompletionItem, CompletionItemKind, InsertTextFormat, Diagnostic, DiagnosticSeverity, DiagnosticTag,
  DocumentSymbol, SymbolKind, Hover, MarkupKind, Location, CodeAction, CodeActionKind, TextEdit, Range, Position,
  SignatureHelp, SignatureInformation, WorkspaceSymbol, WorkspaceEdit, DocumentHighlight, DocumentHighlightKind,
  FileChangeType, DidChangeWatchedFilesNotification,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { Node, walk } from './ast';
import { Analysis, Finding, Res, analyzeFile } from './checker';
import { FileModel, MemberDecl, Project, TypeDecl, lc } from './model';
import { offsetToPosition, positionToOffset } from './parser';
import { collectNodes, docAbove, enclosingType, insideMember, localsAt, pathAt, typeText } from './query';
import { STD_PACKAGES, Ty, tyToString, UNKNOWN } from './builtins';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const project = new Project();

interface Settings {
  sourceRoots: string[];
  autoImport: boolean;
  unusedImports: boolean;
  checkerPath: string;
  checkOnSave: boolean;
}
const DEFAULTS: Settings = { sourceRoots: ['.'], autoImport: true, unusedImports: true, checkerPath: '', checkOnSave: false };
let settings: Settings = { ...DEFAULTS };
let folders: string[] = [];
let hasConfig = false;
const extDiagnostics = new Map<string, Diagnostic[]>();

// ---------------------------------------------------------------------------
// init / indexing
// ---------------------------------------------------------------------------

const toPath = (uri: string) => { try { return fileURLToPath(uri); } catch { return uri; } };

connection.onInitialize((p: InitializeParams): InitializeResult => {
  hasConfig = !!p.capabilities.workspace?.configuration;
  folders = (p.workspaceFolders ?? []).map(f => toPath(f.uri));
  if (!folders.length && p.rootUri) folders = [toPath(p.rootUri)];
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['.', '@', ' ', '(', ','], resolveProvider: true },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports] },
    },
  };
});

connection.onInitialized(async () => {
  await loadSettings();
  rescan();
  connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.ev' }] });
  documents.all().forEach(d => publish(d.uri));
});

async function loadSettings() {
  if (!hasConfig) return;
  const c = (await connection.workspace.getConfiguration('emvus')) as Record<string, any> | null;
  if (!c) return;
  settings = {
    sourceRoots: Array.isArray(c.sourceRoots) && c.sourceRoots.length ? c.sourceRoots : ['.'],
    autoImport: c.completion?.autoImport ?? true,
    unusedImports: c.diagnostics?.unusedImports ?? true,
    checkerPath: c.checker?.path ?? '',
    checkOnSave: !!c.checker?.checkOnSave,
  };
}

connection.onDidChangeConfiguration(async () => {
  await loadSettings();
  rescan();
  documents.all().forEach(d => publish(d.uri));
});

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.vscode']);

function scanDir(dir: string): number {
  let n = 0;
  const walkDir = (d: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walkDir(p, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.ev')) {
        try { project.setFile(pathToFileURL(p).toString(), fs.readFileSync(p, 'utf8')); n++; } catch { /* ignore */ }
      }
    }
  };
  walkDir(dir, 0);
  return n;
}

function rescan() {
  for (const u of [...project.files.keys()]) if (!documents.get(u)) project.removeFile(u);
  let n = 0;
  const seen = new Set<string>();
  for (const f of folders) {
    for (const r of settings.sourceRoots) {
      const dir = path.resolve(f, r);
      if (seen.has(dir) || !fs.existsSync(dir)) continue;
      seen.add(dir);
      n += scanDir(dir);
    }
  }
  for (const d of documents.all()) project.setFile(d.uri, d.getText());
  rev++;
  connection.console.log(`Emvus: indexed ${n} .ev file(s)`);
}

connection.onDidChangeWatchedFiles(ev => {
  for (const c of ev.changes) {
    if (documents.get(c.uri)) continue;
    if (c.type === FileChangeType.Deleted) project.removeFile(c.uri);
    else { try { project.setFile(c.uri, fs.readFileSync(toPath(c.uri), 'utf8')); } catch { /* ignore */ } }
  }
  rev++;
});

// ---------------------------------------------------------------------------
// analysis cache
// ---------------------------------------------------------------------------

let rev = 0;
const cache = new Map<string, { rev: number; a: Analysis }>();

function analysisOf(uri: string): Analysis | undefined {
  const f = project.files.get(uri);
  if (!f) return undefined;
  const hit = cache.get(uri);
  if (hit && hit.rev === rev) return hit.a;
  const a = analyzeFile(project, f);
  cache.set(uri, { rev, a });
  return a;
}

const timers = new Map<string, NodeJS.Timeout>();
documents.onDidChangeContent(e => {
  project.setFile(e.document.uri, e.document.getText());
  rev++;
  const prev = timers.get(e.document.uri);
  if (prev) clearTimeout(prev);
  timers.set(e.document.uri, setTimeout(() => {
    publish(e.document.uri);
    // other open documents may depend on declarations of this file
    for (const d of documents.all()) if (d.uri !== e.document.uri) publish(d.uri);
  }, 250));
});
documents.onDidClose(e => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  try { project.setFile(e.document.uri, fs.readFileSync(toPath(e.document.uri), 'utf8')); } catch { project.removeFile(e.document.uri); }
  rev++;
});
documents.onDidSave(e => { if (settings.checkOnSave && settings.checkerPath) void runChecker(e.document.uri); });

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

function rangeOf(f: FileModel, start: number, end: number): Range {
  return Range.create(offsetToPosition(f.parse.lineStarts, start), offsetToPosition(f.parse.lineStarts, end));
}

function unusedImports(f: FileModel): Finding[] {
  const out: Finding[] = [];
  const inUse = (t: { start: number; end: number }) => f.useNodes.some(u => t.start >= u.start && t.end <= u.end);
  const used = new Set<string>();
  for (const t of f.parse.tokens) if ((t.kind === 'id' || t.kind === 'kw') && !inUse(t)) used.add(lc(t.text));
  // annotations like @Logged use the macro by name; they are tokens too, so covered above
  for (const u of f.uses) {
    const short = lc(u.alias || u.path.split('.').pop()!);
    if (!used.has(short) && !project.packageKnown(u.path)) {
      out.push({
        start: u.node.nameStart ?? u.node.start, end: u.node.end, line: u.node.line, col: u.node.col,
        message: `Unused import '${u.path}'`, severity: 'hint', code: 'unused-import', unnecessary: true,
      });
    }
  }
  return out;
}

function toDiagnostic(f: FileModel, x: Finding): Diagnostic {
  const d: Diagnostic = {
    range: rangeOf(f, x.start, x.end), message: x.message, source: 'emvus', code: x.code, data: x.data,
    severity: x.severity === 'error' ? DiagnosticSeverity.Error : x.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
  };
  if (x.unnecessary) d.tags = [DiagnosticTag.Unnecessary];
  return d;
}

function publish(uri: string) {
  const f = project.files.get(uri);
  if (!f) return;
  const a = analysisOf(uri)!;
  const diags: Diagnostic[] = [];
  for (const s of f.parse.diagnostics) {
    diags.push({
      range: rangeOf(f, s.start, s.end), message: s.message, source: 'emvus',
      severity: s.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning, code: 'syntax',
    });
  }
  // semantic checks on a file that does not parse produce noise; keep them but they are already tolerant
  for (const x of a.findings) diags.push(toDiagnostic(f, x));
  if (settings.unusedImports) for (const x of unusedImports(f)) diags.push(toDiagnostic(f, x));
  connection.sendDiagnostics({ uri, diagnostics: [...diags, ...(extDiagnostics.get(uri) ?? [])] });
}

// optional external checker: `<checker> <file> --check`, lines `error <line>: message`
async function runChecker(uri: string) {
  const file = toPath(uri);
  const out = await new Promise<string>(resolve => {
    let buf = '';
    const c = spawn(settings.checkerPath, [file, '--check'], { cwd: path.dirname(file) });
    const timer = setTimeout(() => c.kill(), 60_000);
    c.stdout.on('data', d => (buf += d));
    c.stderr.on('data', d => (buf += d));
    c.on('error', e => { clearTimeout(timer); resolve(`error 1: could not start checker: ${e.message}`); });
    c.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  const diags: Diagnostic[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(error|warning)\s+(\d+)(?::(\d+))?:\s*(.*)$/.exec(line);
    if (!m) continue;
    const l = Math.max(0, +m[2] - 1);
    const c = m[3] ? Math.max(0, +m[3] - 1) : 0;
    diags.push({
      range: Range.create(l, c, l, c + 1), message: m[4], source: 'emvus-checker',
      severity: m[1] === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    });
  }
  extDiagnostics.set(uri, diags);
  publish(uri);
  void os;
}

connection.onRequest('emvus/check', async (p: { uri: string }) => {
  if (settings.checkerPath) await runChecker(p.uri);
  else connection.window.showInformationMessage('Set "emvus.checker.path" to run an external checker.');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function importEdit(f: FileModel, importPath: string): TextEdit {
  const line = `use ${importPath}`;
  if (f.useNodes.length) {
    const last = f.useNodes.reduce((a, b) => (b.end > a.end ? b : a));
    return TextEdit.insert(offsetToPosition(f.parse.lineStarts, last.end), '\n' + line);
  }
  if (f.pkgNode) return TextEdit.insert(offsetToPosition(f.parse.lineStarts, f.pkgNode.end), '\n\n' + line);
  return TextEdit.insert(Position.create(0, 0), line + '\n\n');
}

function qualified(t: TypeDecl): string {
  return t.pkg ? `${t.pkg}.${t.name}` : t.name;
}

function kindOfType(t: TypeDecl): CompletionItemKind {
  switch (t.kind) {
    case 'interface': return CompletionItemKind.Interface;
    case 'enum': return CompletionItemKind.Enum;
    case 'record': case 'data-class': return CompletionItemKind.Struct;
    case 'exception': return CompletionItemKind.Class;
    default: return t.builtinKind === 'interface' ? CompletionItemKind.Interface : CompletionItemKind.Class;
  }
}

function paramSig(m: MemberDecl): string {
  return m.params.map(p => `${tyToString(p.ty)} ${p.name}${p.hasDefault ? ' = …' : ''}`).join(', ');
}

function memberSignature(m: MemberDecl): string {
  const mods = [m.isPrivate ? 'private' : m.isProtected ? 'protected' : '', m.isStatic ? 'static' : '', m.isAbstract ? 'abstract' : '', m.isOverride ? 'override' : '']
    .filter(Boolean).join(' ');
  const pre = mods ? mods + ' ' : '';
  switch (m.kind) {
    case 'method': return `${pre}method<${tyToString(m.ty)}> ${m.name}(${paramSig(m)})`;
    case 'constructor': return `${m.name}(${paramSig(m)})`;
    case 'property': return `${pre}${tyToString(m.ty)} ${m.name} { ${m.accessors.join(', ') || 'get'} }`;
    case 'field': return `${pre}${tyToString(m.ty)} ${m.name}`;
    case 'enum-entry': return `${m.owner?.name ?? ''}.${m.name}`;
    default: return `${m.name}: ${tyToString(m.ty)}`;
  }
}

function typeSignature(t: TypeDecl): string {
  const kind = t.kind === 'data-class' ? 'data class' : t.kind === 'builtin' ? (t.builtinKind ?? 'type') : t.kind;
  const gen = t.generics.length ? `<${t.generics.join(', ')}>` : '';
  const prm = t.params.length ? `(${t.params.map(p => `${tyToString(p.ty)} ${p.name}`).join(', ')})` : '';
  const based = t.based.length ? ` based ${t.based.map(tyToString).join(', ')}` : '';
  const impl = t.implements.length ? ` implements ${t.implements.map(tyToString).join(', ')}` : '';
  return `${kind} ${t.name}${gen}${prm}${based}${impl}`;
}

function nodeAtOffset(f: FileModel, offset: number): Node | undefined {
  // innermost node whose *name range* covers the offset
  let best: Node | undefined;
  walk(f.parse.root, n => {
    const s = n.nameStart, e = n.nameEnd;
    if (s !== undefined && e !== undefined && offset >= s && offset <= e) {
      if (!best || (e - s) <= ((best.nameEnd ?? 0) - (best.nameStart ?? 0))) best = n;
    }
  });
  return best;
}

interface Target {
  kind: 'type' | 'member' | 'var' | 'macro';
  type?: TypeDecl;
  member?: MemberDecl;
  decl?: Node;
  name: string;
}

/** What does the thing under `offset` refer to? */
function targetAt(uri: string, offset: number): { t: Target; node: Node } | null {
  const f = project.files.get(uri);
  const a = analysisOf(uri);
  if (!f || !a) return null;
  const n = nodeAtOffset(f, offset);
  if (!n) return null;
  return targetOfNode(f, a, n);
}

function targetOfNode(f: FileModel, a: Analysis, n: Node): { t: Target; node: Node } | null {
  // declarations
  const declTypes = ['class', 'data-class', 'record', 'interface', 'exception', 'enum'];
  if (declTypes.includes(n.kind)) {
    const t = f.types.find(x => x.node === n);
    if (t) return { t: { kind: 'type', type: t, name: t.name }, node: n };
  }
  if (['method', 'property', 'field', 'constructor', 'enum-entry', 'variable'].includes(n.kind)) {
    for (const t of f.types) {
      const m = t.members.find(x => x.node === n);
      if (m) return { t: { kind: 'member', member: m, name: m.name }, node: n };
    }
    const m = [...f.methods, ...f.variables].find(x => x.node === n);
    if (m) return { t: { kind: 'member', member: m, name: m.name }, node: n };
  }
  if (n.kind === 'param' || n.kind === 'local' || n.kind === 'foreach' || n.kind === 'binding') {
    // data class / record primary parameters are properties
    const owner = f.types.find(t => t.params.some(p => p.node === n));
    if (owner) {
      const m = owner.members.find(x => x.node === n);
      if (m) return { t: { kind: 'member', member: m, name: m.name }, node: n };
    }
    return { t: { kind: 'var', decl: n, name: n.text }, node: n };
  }
  if (n.kind === 'macro') return { t: { kind: 'macro', decl: n, name: n.text }, node: n };
  if (n.kind === 'type' || n.kind === 'generic-ref') {
    const d = project.resolve(f, n.text);
    return d ? { t: { kind: 'type', type: d, name: d.name }, node: n } : null;
  }
  if (n.kind === 'use-item') {
    const d = project.byPath(n.text);
    return d ? { t: { kind: 'type', type: d, name: d.name }, node: n } : null;
  }
  if (n.kind === 'annotation') {
    for (const ff of project.files.values()) {
      const mac = ff.macros.find(x => lc(x.name) === lc(n.text));
      if (mac) return { t: { kind: 'macro', decl: mac.node, name: mac.name }, node: n };
    }
    return null;
  }
  const r: Res | undefined = a.res.get(n);
  if (r) {
    if (r.typeRef) return { t: { kind: 'type', type: r.typeRef, name: r.typeRef.name }, node: n };
    if (r.member) return { t: { kind: 'member', member: r.member, name: r.member.name }, node: n };
    if (r.varDecl) return { t: { kind: 'var', decl: r.varDecl, name: r.varName ?? n.text }, node: n };
  }
  return null;
}

function sameTarget(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'type') return a.type === b.type;
  if (a.kind === 'member') {
    if (a.member === b.member) return true;
    // generated/overridden members: same owner + name + arity
    return !!a.member && !!b.member && a.member.owner === b.member.owner && lc(a.member.name) === lc(b.member.name) && a.member.params.length === b.member.params.length;
  }
  return a.decl === b.decl;
}

function locationOf(t: Target): Location | null {
  let node: Node | null | undefined;
  let file: FileModel | undefined;
  if (t.kind === 'type') { node = t.type?.node; file = t.type?.file ?? undefined; }
  else if (t.kind === 'member') { node = t.member?.node ?? t.member?.owner?.node; file = t.member?.owner?.file ?? undefined; }
  else node = t.decl;
  if (t.kind === 'member' && !file) {
    for (const f of project.files.values()) {
      if (f.methods.includes(t.member!) || f.variables.includes(t.member!)) { file = f; break; }
    }
  }
  if (t.kind === 'var' || t.kind === 'macro') {
    for (const f of project.files.values()) {
      let hit = false;
      walk(f.parse.root, n => { if (n === node) hit = true; });
      if (hit) { file = f; break; }
    }
  }
  if (!node || !file) return null;
  const s = node.nameStart ?? node.start, e = node.nameEnd ?? node.end;
  return Location.create(file.uri, rangeOf(file, s, e));
}

function allReferences(t: Target, onlyUri?: string): Array<{ f: FileModel; s: number; e: number }> {
  const out: Array<{ f: FileModel; s: number; e: number }> = [];
  const key = lc(t.name);
  const files = onlyUri ? [project.files.get(onlyUri)!].filter(Boolean) : [...project.files.values()];
  for (const f of files) {
    const a = analysisOf(f.uri);
    if (!a) continue;
    walk(f.parse.root, n => {
      if (n.nameStart === undefined || n.nameEnd === undefined) return;
      let nm = n.text;
      let s = n.nameStart, e = n.nameEnd;
      if (n.kind === 'use-item') {
        const last = n.text.split('.').pop()!;
        nm = last;
        s = n.nameEnd - last.length;
        const al = n.children.find(c => c.kind === 'alias');
        if (al) { e = s + last.length; }
      }
      if (n.kind === 'type' || n.kind === 'generic-ref') nm = n.text.split('.').pop()!;
      if (lc(nm) !== key) return;
      const r = targetOfNode(f, a, n);
      if (r && sameTarget(r.t, t)) {
        if (n.kind === 'type' && n.text.includes('.')) s = n.nameEnd - nm.length;
        out.push({ f, s, e });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

function inUseStatement(f: FileModel, tokIdx: number): boolean {
  const t = f.parse.tokens;
  let depth = 0;
  for (let i = tokIdx; i >= 0; i--) {
    const k = t[i];
    if (k.kind === 'kw' && k.text === 'use') return true;
    if (k.kind === 'sym') {
      if (k.text === '}') { depth++; continue; }
      if (k.text === '{') {
        if (depth === 0) return t[i - 1]?.kind === 'kw' && t[i - 1].text === 'use';
        depth--;
        continue;
      }
      if (['.', ',', '[', ']'].includes(k.text)) continue;
      return false;
    }
    if (k.kind === 'id' || (k.kind === 'kw' && k.text === 'as')) continue;
    return false;
  }
  return false;
}

function completeUse(prefix: string): CompletionItem[] {
  const parts = prefix.split('.');
  const base = parts.slice(0, -1).join('.');
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const pkgs = new Set<string>([...project.packages().filter(Boolean), ...Object.keys(STD_PACKAGES)]);
  const depth = base ? base.split('.').length : 0;
  for (const p of pkgs) {
    const segs = p.split('.');
    if (segs.length <= depth) continue;
    if (base && !p.startsWith(base + '.')) continue;
    const label = segs[depth];
    if (seen.has('p:' + label)) continue;
    seen.add('p:' + label);
    items.push({ label, kind: CompletionItemKind.Module, detail: segs.slice(0, depth + 1).join('.'), insertText: label, sortText: '0' + label, command: { title: '', command: 'editor.action.triggerSuggest' } });
  }
  const names = new Set<string>();
  for (const t of project.typesInPackage(base)) names.add(t.name);
  for (const n of STD_PACKAGES[base] ?? []) names.add(n);
  for (const n of names) {
    if (seen.has('t:' + n)) continue;
    seen.add('t:' + n);
    const d = project.byPath(base ? `${base}.${n}` : n);
    items.push({ label: n, kind: d ? kindOfType(d) : CompletionItemKind.Class, detail: base ? `${base}.${n}` : n, sortText: '1' + n });
  }
  return items;
}

function memberItem(m: MemberDecl, rank: string): CompletionItem {
  if (m.kind === 'property' || m.kind === 'field' || m.kind === 'enum-entry') {
    return {
      label: m.name, kind: m.kind === 'enum-entry' ? CompletionItemKind.EnumMember : CompletionItemKind.Property,
      detail: `${tyToString(m.ty)}  — ${m.owner?.name ?? ''}`, sortText: rank + m.name,
    };
  }
  const snippet = m.params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ');
  return {
    label: m.name, kind: CompletionItemKind.Method,
    detail: `(${paramSig(m)}): ${tyToString(m.ty)}  — ${m.owner?.name ?? ''}`,
    insertText: `${m.name}(${snippet})`, insertTextFormat: InsertTextFormat.Snippet, sortText: rank + m.name,
    labelDetails: { detail: `(${paramSig(m)})`, description: tyToString(m.ty) },
  };
}

function completeMembers(f: FileModel, ty: Ty, isStatic: boolean, offset: number): CompletionItem[] {
  if (ty.n === '?' || !ty.n) return [];
  const d = project.resolve(f, ty.n);
  if (!d) return [];
  const cur = enclosingType(f.parse.root, offset);
  const here = cur ? f.types.find(t => t.node === cur) : undefined;
  let mems = project.allMembers(d).filter(m => m.kind !== 'constructor' && m.kind !== 'variable');
  mems = mems.filter(m => !m.isPrivate || m.owner === here);
  if (isStatic) mems = mems.filter(m => m.isStatic || m.kind === 'enum-entry');
  else mems = mems.filter(m => !m.isStatic && m.kind !== 'enum-entry');
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const m of mems) {
    const k = `${m.kind === 'method' ? 'm' : 'p'}:${lc(m.name)}:${m.params.length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(memberItem(m, m.owner === d ? '0' : '1'));
  }
  return items;
}

connection.onCompletion((p): CompletionItem[] => {
  const doc = documents.get(p.textDocument.uri);
  const f = project.files.get(p.textDocument.uri);
  const a = analysisOf(p.textDocument.uri);
  if (!doc || !f || !a) return [];
  const text = doc.getText();
  const offset = doc.offsetAt(p.position);

  // word start
  let w = offset;
  while (w > 0 && /[A-Za-z0-9_]/.test(text[w - 1])) w--;
  const tokens = f.parse.tokens;
  // index of the last token that ends at or before w
  let li = -1;
  for (let i = 0; i < tokens.length; i++) { if (tokens[i].kind !== 'eof' && tokens[i].end <= w) li = i; else if (tokens[i].start >= w) break; }
  const before = li >= 0 ? tokens[li] : undefined;

  // use declarations
  if (li >= 0 || true) {
    const lineStart = f.parse.lineStarts[p.position.line] ?? 0;
    const linePrefix = text.slice(lineStart, offset);
    const m = /([A-Za-z_][\w.]*)$/.exec(linePrefix);
    if (inUseStatement(f, li < 0 ? 0 : li + (before && before.end <= w && !/[.]$/.test(before.text) ? 0 : 0))) {
      const pref = m ? m[1] : '';
      if (linePrefix.trimStart().startsWith('use') || /[.{,\[\s]$/.test(linePrefix.slice(0, linePrefix.length - pref.length) || ' ')) {
        return completeUse(pref);
      }
    }
  }

  // annotation / macro names
  if (before && before.kind === 'sym' && before.text === '@') {
    const names = new Set<string>();
    const items: CompletionItem[] = [];
    for (const ff of project.files.values()) {
      for (const mac of ff.macros) {
        if (names.has(lc(mac.name))) continue;
        names.add(lc(mac.name));
        items.push({ label: mac.name, kind: CompletionItemKind.Event, detail: `macro on ${mac.targets.join(', ')}`, sortText: '0' + mac.name });
      }
    }
    for (const b of ['Async', 'Synchronized']) if (!names.has(lc(b))) items.push({ label: b, kind: CompletionItemKind.Event, detail: 'annotation', sortText: '1' + b });
    return items;
  }

  // member access: `.` or cascade `..`
  if (before && before.kind === 'sym' && (before.text === '.' || before.text === '..')) {
    const prev = tokens[li - 1];
    if (prev) {
      let best: { n: Node; ty: Ty } | undefined;
      for (const [n, ty] of a.types) {
        if (n.end === prev.end && (!best || n.end - n.start > best.n.end - best.n.start)) best = { n, ty };
      }
      if (best) {
        const isStatic = a.res.get(best.n)?.typeRef !== undefined && (best.n.kind === 'name' || best.n.kind === 'generic-ref');
        return completeMembers(f, best.ty, isStatic, offset);
      }
    }
    return [];
  }

  return completeGeneral(f, a, offset);
});

function completeGeneral(f: FileModel, a: Analysis, offset: number): CompletionItem[] {
  void a;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (i: CompletionItem) => {
    const k = `${i.kind}:${i.label}:${i.detail ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(i);
  };
  const root = f.parse.root;
  const member = insideMember(root, offset);
  const typeNode = enclosingType(root, offset);
  const here = typeNode ? f.types.find(t => t.node === typeNode) : undefined;
  const inBody = !!member && member.kind !== 'macro' ? true : !!member;

  // locals / params
  for (const l of localsAt(root, offset)) {
    add({ label: l.name, kind: l.kind === 'param' ? CompletionItemKind.Variable : CompletionItemKind.Variable, detail: l.type || undefined, sortText: '0' + l.name });
  }
  if (here && member) add({ label: 'this', kind: CompletionItemKind.Keyword, sortText: '0this' });

  // implicit members of the enclosing type
  if (here && member) {
    for (const m of project.allMembers(here)) {
      if (m.kind === 'constructor' || m.kind === 'variable') continue;
      if (m.owner?.kind === 'builtin') continue;
      add(memberItem(m, '1'));
    }
  }
  // top-level methods / variables in this package
  for (const ff of project.files.values()) {
    if (ff.pkg !== f.pkg) continue;
    for (const m of ff.methods) add({ ...memberItem(m, '2'), detail: `(${paramSig(m)}): ${tyToString(m.ty)}` });
    for (const v of ff.variables) add({ label: v.name, kind: CompletionItemKind.Constant, detail: tyToString(v.ty), sortText: '2' + v.name });
  }
  for (const fn of ['println', 'print', 'errprintln', 'panic']) {
    add({ label: fn, kind: CompletionItemKind.Function, detail: 'builtin', insertText: `${fn}($1)`, insertTextFormat: InsertTextFormat.Snippet, sortText: '3' + fn });
  }

  // keywords by context
  const bodyKw = ['if', 'while', 'for', 'switch', 'return', 'fail', 'success', 'break', 'continue', 'final', 'scoped', 'var', 'dynamic', 'null', 'true', 'false', 'fiber', 'virtual', 'thread', 'quote', 'is', 'as', 'in'];
  const memberKw = ['public', 'private', 'protected', 'static', 'abstract', 'override', 'final', 'method', 'var', 'class', 'interface', 'record', 'enum', 'exception', 'macro', 'data', 'based', 'implements', 'where', 'on'];
  const topKw = ['package', 'use', 'class', 'data class', 'record', 'interface', 'enum', 'exception', 'method', 'macro', 'final', 'var', 'public', 'private', 'static', 'abstract', 'where', 'based', 'implements', 'on'];
  const kws = inBody ? bodyKw : here ? memberKw : topKw;
  for (const k of kws) add({ label: k, kind: CompletionItemKind.Keyword, sortText: '5' + k });

  // types
  const typeParams = new Set<string>(here?.generics ?? []);
  for (const g of typeParams) add({ label: g, kind: CompletionItemKind.TypeParameter, detail: 'type parameter', sortText: '3' + g });
  for (const t of project.builtins.values()) {
    add({ label: t.name, kind: kindOfType(t), detail: 'builtin ' + (t.builtinKind ?? ''), sortText: '4' + t.name });
  }
  for (const t of project.allTypes()) {
    const visible = project.resolve(f, t.name) === t;
    if (visible) add({ label: t.name, kind: kindOfType(t), detail: qualified(t), sortText: '3' + t.name, data: { type: qualified(t) } });
    else if (settings.autoImport && t.pkg && t.pkg !== f.pkg && !project.resolve(f, t.name)) {
      add({
        label: t.name, kind: kindOfType(t), detail: `auto-import ${qualified(t)}`, sortText: '6' + t.name,
        additionalTextEdits: [importEdit(f, qualified(t))], labelDetails: { description: t.pkg }, data: { type: qualified(t) },
      });
    }
  }
  return items;
}

connection.onCompletionResolve((item): CompletionItem => {
  const q = (item.data as { type?: string } | undefined)?.type;
  if (q) {
    const t = project.byPath(q);
    if (t) {
      let md = '```emvus\n' + typeSignature(t) + '\n```';
      if (t.file && t.node) { const d = docAbove(t.file, t.node.start); if (d) md += '\n\n' + d; }
      item.documentation = { kind: MarkupKind.Markdown, value: md };
    }
  }
  return item;
});

// ---------------------------------------------------------------------------
// hover / definition / references / rename / highlight
// ---------------------------------------------------------------------------

function hoverFor(t: Target, node: Node, f: FileModel, a: Analysis): string {
  if (t.kind === 'type' && t.type) {
    let md = '```emvus\n' + typeSignature(t.type) + '\n```';
    if (t.type.file && t.type.node) { const d = docAbove(t.type.file, t.type.node.start); if (d) md += '\n\n' + d; }
    const pub = t.type.members.filter(m => !m.isPrivate && m.kind !== 'constructor' && m.kind !== 'variable');
    if (pub.length) {
      md += '\n\n' + pub.slice(0, 14).map(m => '- `' + memberSignature(m) + '`').join('\n');
      if (pub.length > 14) md += `\n- … ${pub.length - 14} more`;
    }
    return md;
  }
  if (t.kind === 'member' && t.member) {
    const m = t.member;
    let md = '```emvus\n' + memberSignature(m) + '\n```';
    const file = m.owner?.file ?? f;
    if (m.node && file) { const d = docAbove(file, m.node.start); if (d) md += '\n\n' + d; }
    if (m.node === null && m.owner?.kind !== 'builtin') md += '\n\n_generated by the data class_';
    return md;
  }
  if (t.kind === 'var' && t.decl) {
    const ty = a.res.get(node)?.ty ?? a.types.get(node);
    const declared = typeText(t.decl.children.find(c => c.kind === 'type' || c.kind === 'tuple-type'));
    const shown = declared && declared !== 'var' ? declared : ty ? tyToString(ty) : '';
    return '```emvus\n' + `(variable) ${shown ? shown + ' ' : ''}${t.name}` + '\n```';
  }
  if (t.kind === 'macro') return '```emvus\n' + `macro ${t.name}` + '\n```';
  return '';
}

connection.onHover((p): Hover | null => {
  const doc = documents.get(p.textDocument.uri);
  const f = project.files.get(p.textDocument.uri);
  const a = analysisOf(p.textDocument.uri);
  if (!doc || !f || !a) return null;
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  if (!r) return null;
  const md = hoverFor(r.t, r.node, f, a);
  if (!md) return null;
  return { contents: { kind: MarkupKind.Markdown, value: md }, range: rangeOf(f, r.node.nameStart ?? r.node.start, r.node.nameEnd ?? r.node.end) };
});

connection.onDefinition((p): Location | null => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return null;
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  return r ? locationOf(r.t) : null;
});

connection.onReferences(p => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  if (!r) return [];
  return allReferences(r.t).map(x => Location.create(x.f.uri, rangeOf(x.f, x.s, x.e)));
});

connection.onDocumentHighlight((p): DocumentHighlight[] => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  if (!r) return [];
  return allReferences(r.t, p.textDocument.uri).map(x => ({ range: rangeOf(x.f, x.s, x.e), kind: DocumentHighlightKind.Text }));
});

connection.onPrepareRename(p => {
  const doc = documents.get(p.textDocument.uri);
  const f = project.files.get(p.textDocument.uri);
  if (!doc || !f) return null;
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  if (!r) return null;
  if (r.t.kind === 'type' && r.t.type?.kind === 'builtin') return null;
  if (r.t.kind === 'member' && (r.t.member?.owner?.kind === 'builtin' || !r.t.member?.node)) return null;
  const s = r.node.nameStart ?? r.node.start;
  const e = r.node.nameEnd ?? r.node.end;
  return { range: rangeOf(f, s, e), placeholder: r.t.name };
});

connection.onRenameRequest((p): WorkspaceEdit | null => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.newName)) return null;
  const r = targetAt(p.textDocument.uri, doc.offsetAt(p.position));
  if (!r) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const x of allReferences(r.t)) (changes[x.f.uri] ??= []).push(TextEdit.replace(rangeOf(x.f, x.s, x.e), p.newName));
  return { changes };
});

// ---------------------------------------------------------------------------
// symbols
// ---------------------------------------------------------------------------

connection.onDocumentSymbol(p => {
  const f = project.files.get(p.textDocument.uri);
  if (!f) return [];
  const out: DocumentSymbol[] = [];
  const sel = (n: Node) => rangeOf(f, n.nameStart ?? n.start, n.nameEnd ?? n.end);
  const full = (n: Node) => rangeOf(f, n.start, n.end);
  const memberSym = (m: MemberDecl): DocumentSymbol | null => {
    if (!m.node || m.node.start === undefined) return null;
    const kind = m.kind === 'method' ? SymbolKind.Method : m.kind === 'constructor' ? SymbolKind.Constructor
      : m.kind === 'property' ? SymbolKind.Property : m.kind === 'enum-entry' ? SymbolKind.EnumMember : SymbolKind.Field;
    return {
      name: m.name,
      detail: m.kind === 'method' ? `(${paramSig(m)}): ${tyToString(m.ty)}` : m.kind === 'constructor' ? `(${paramSig(m)})` : tyToString(m.ty),
      kind, range: full(m.node), selectionRange: sel(m.node),
    };
  };
  for (const t of f.types) {
    if (!t.node) continue;
    out.push({
      name: t.name, detail: t.generics.length ? `<${t.generics.join(', ')}>` : undefined,
      kind: t.kind === 'interface' ? SymbolKind.Interface : t.kind === 'enum' ? SymbolKind.Enum : t.kind === 'data-class' || t.kind === 'record' ? SymbolKind.Struct : SymbolKind.Class,
      range: full(t.node), selectionRange: sel(t.node),
      children: t.members.map(memberSym).filter((x): x is DocumentSymbol => !!x && x.range.start.line >= 0),
    });
  }
  for (const m of f.methods) { const s = memberSym(m); if (s) out.push({ ...s, kind: SymbolKind.Function }); }
  for (const v of f.variables) { const s = memberSym(v); if (s) out.push({ ...s, kind: SymbolKind.Constant }); }
  for (const mac of f.macros) out.push({ name: mac.name, detail: `macro on ${mac.targets.join(', ')}`, kind: SymbolKind.Event, range: full(mac.node), selectionRange: sel(mac.node) });
  return out;
});

connection.onWorkspaceSymbol((p): WorkspaceSymbol[] => {
  const q = p.query.toLowerCase();
  const out: WorkspaceSymbol[] = [];
  for (const f of project.files.values()) {
    for (const t of f.types) {
      if (!t.node) continue;
      if (!q || lc(t.name).includes(q)) {
        out.push({ name: t.name, containerName: t.pkg, kind: t.kind === 'interface' ? SymbolKind.Interface : t.kind === 'enum' ? SymbolKind.Enum : SymbolKind.Class, location: Location.create(f.uri, rangeOf(f, t.node.nameStart ?? t.node.start, t.node.nameEnd ?? t.node.end)) });
      }
      if (q.length >= 2) {
        for (const m of t.members) {
          if (!m.node || m.kind === 'constructor' || !lc(m.name).includes(q)) continue;
          out.push({ name: m.name, containerName: t.name, kind: m.kind === 'method' ? SymbolKind.Method : SymbolKind.Property, location: Location.create(f.uri, rangeOf(f, m.node.nameStart ?? m.node.start, m.node.nameEnd ?? m.node.end)) });
        }
      }
    }
    if (q.length >= 2) {
      for (const m of f.methods) {
        if (m.node && lc(m.name).includes(q)) out.push({ name: m.name, containerName: f.pkg, kind: SymbolKind.Function, location: Location.create(f.uri, rangeOf(f, m.node.nameStart ?? m.node.start, m.node.nameEnd ?? m.node.end)) });
      }
    }
    if (out.length > 300) break;
  }
  return out;
});

// ---------------------------------------------------------------------------
// signature help
// ---------------------------------------------------------------------------

connection.onSignatureHelp((p): SignatureHelp | null => {
  const doc = documents.get(p.textDocument.uri);
  const f = project.files.get(p.textDocument.uri);
  const a = analysisOf(p.textDocument.uri);
  if (!doc || !f || !a) return null;
  const offset = doc.offsetAt(p.position);
  const path_ = pathAt(f.parse.root, offset);
  let call: Node | undefined;
  for (let i = path_.length - 1; i >= 0; i--) {
    const n = path_[i];
    if (n.kind === 'call' && offset > n.children[0].end) { call = n; break; }
  }
  if (!call) return null;
  const callee = call.children[0];
  const res = a.res.get(callee);
  let cands: MemberDecl[] = [];
  if (res?.member) {
    const owner = res.member.owner;
    cands = owner ? project.allMembers(owner).filter(m => lc(m.name) === lc(res.member!.name) && m.kind === 'method') : [res.member];
    if (!cands.length) cands = [res.member];
  } else if (res?.typeRef) {
    const t = res.typeRef;
    cands = t.members.filter(m => m.kind === 'constructor');
    if (!cands.length && t.params.length) {
      cands = [{ name: t.name, kind: 'constructor', node: null, owner: t, ty: { n: t.name, a: [] }, params: t.params, generics: [], isStatic: false, isAbstract: false, isPrivate: false, isProtected: false, isOverride: false, isFinal: false, accessors: [], hasInit: false, nullInit: false, hasBody: true, annotations: [], placeholder: false }];
    }
  }
  if (!cands.length) return null;
  const args = call.children.slice(1);
  let active = args.filter(x => x.end < offset).length;
  const sigs: SignatureInformation[] = cands.map(m => ({
    label: m.kind === 'constructor' ? `${m.name}(${paramSig(m)})` : `${m.name}(${paramSig(m)}): ${tyToString(m.ty)}`,
    parameters: m.params.map(x => ({ label: `${tyToString(x.ty)} ${x.name}${x.hasDefault ? ' = …' : ''}` })),
  }));
  let idx = cands.findIndex(m => m.params.length > active);
  if (idx < 0) idx = 0;
  if (active >= cands[idx].params.length) active = Math.max(0, cands[idx].params.length - 1);
  return { signatures: sigs, activeSignature: idx, activeParameter: active };
});

// ---------------------------------------------------------------------------
// code actions
// ---------------------------------------------------------------------------

function organizeImports(f: FileModel): TextEdit | null {
  // only plain `use a.b.C [as D]` lines are rewritten; use blocks are left alone
  const plain = f.useNodes.filter(n => n.children.length === 1 && !f.text.slice(n.start, n.end).includes('{'));
  if (plain.length < 2 && !f.useNodes.length) return null;
  if (plain.length !== f.useNodes.length || !plain.length) return null;
  const first = plain.reduce((a, b) => (b.start < a.start ? b : a));
  const last = plain.reduce((a, b) => (b.end > a.end ? b : a));
  const between = f.parse.tokens.filter(t => t.start >= first.start && t.end <= last.end);
  if (between.some(t => !plain.some(n => t.start >= n.start && t.end <= n.end))) return null;
  const unused = new Set(unusedImports(f).map(x => x.start));
  const lines = new Set<string>();
  for (const u of f.uses) {
    if (unused.has(u.node.nameStart ?? u.node.start)) continue;
    lines.add(`use ${u.path}${u.alias ? ' as ' + u.alias : ''}`);
  }
  return TextEdit.replace(rangeOf(f, first.start, last.end), [...lines].sort().join('\n'));
}

connection.onCodeAction((p): CodeAction[] => {
  const f = project.files.get(p.textDocument.uri);
  if (!f) return [];
  const actions: CodeAction[] = [];
  for (const d of p.context.diagnostics) {
    const code = d.code as string | undefined;
    if (code === 'unknown-type' || code === 'unknown-name') {
      const name = (d.data as { name?: string } | undefined)?.name;
      if (!name) continue;
      for (const t of project.allTypes()) {
        if (lc(t.name) !== lc(name.split('.').pop()!) || !t.pkg || t.pkg === f.pkg) continue;
        actions.push({
          title: `Import '${qualified(t)}'`, kind: CodeActionKind.QuickFix, diagnostics: [d], isPreferred: true,
          edit: { changes: { [f.uri]: [importEdit(f, qualified(t))] } },
        });
      }
      for (const [pkg, names] of Object.entries(STD_PACKAGES)) {
        if (names.some(n => lc(n) === lc(name)) && project.builtins.has(lc(name))) {
          actions.push({
            title: `Import '${pkg}.${names.find(n => lc(n) === lc(name))}'`, kind: CodeActionKind.QuickFix, diagnostics: [d],
            edit: { changes: { [f.uri]: [importEdit(f, `${pkg}.${names.find(n => lc(n) === lc(name))}`)] } },
          });
        }
      }
    } else if (code === 'unused-import' || code === 'duplicate-use') {
      const start = positionToOffset(f.parse.lineStarts, f.text.length, d.range.start.line, d.range.start.character);
      const use = f.useNodes.find(n => start >= n.start && start <= n.end);
      if (use && use.children.length === 1) {
        let end = use.end;
        if (f.text[end] === '\r') end++;
        if (f.text[end] === '\n') end++;
        actions.push({
          title: 'Remove unused import', kind: CodeActionKind.QuickFix, diagnostics: [d],
          edit: { changes: { [f.uri]: [TextEdit.del(rangeOf(f, use.start, end))] } },
        });
      }
    }
  }
  const org = organizeImports(f);
  if (org) actions.push({ title: 'Organize imports', kind: CodeActionKind.SourceOrganizeImports, edit: { changes: { [f.uri]: [org] } } });
  return actions;
});

documents.listen(connection);
connection.listen();
void UNKNOWN;
void collectNodes;
