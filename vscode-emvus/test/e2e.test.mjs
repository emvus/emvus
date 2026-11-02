import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rpc = require('vscode-jsonrpc/node');
const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'dist', 'server.js');
const root = path.join(here, 'fixture');
const rootUri = pathToFileURL(root).toString();

let proc, conn;
const diags = new Map();

before(async () => {
  proc = spawn('node', [server, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  conn = rpc.createMessageConnection(new rpc.StreamMessageReader(proc.stdout), new rpc.StreamMessageWriter(proc.stdin));
  conn.onNotification('textDocument/publishDiagnostics', p => diags.set(p.uri, p.diagnostics));
  conn.onRequest('workspace/configuration', () => [{}]);
  conn.onRequest('client/registerCapability', () => null);
  conn.onNotification('window/showMessage', () => {});
  conn.onNotification('window/logMessage', () => {});
  conn.listen();
  await conn.sendRequest('initialize', {
    processId: process.pid, rootUri, capabilities: { workspace: { configuration: true } },
    workspaceFolders: [{ uri: rootUri, name: 'fixture' }],
  });
  conn.sendNotification('initialized', {});
  await new Promise(r => setTimeout(r, 700));
});
after(() => { conn.dispose(); proc.kill(); });

let n = 0;
async function open(text) {
  const marker = text.indexOf('/*|*/');
  const clean = text.replace('/*|*/', '');
  const uri = pathToFileURL(path.join(root, `T${n++}.ev`)).toString();
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'emvus', version: 1, text: clean } });
  const before = clean.slice(0, marker < 0 ? 0 : marker).split('\n');
  await new Promise(r => setTimeout(r, 450));
  return { uri, position: { line: before.length - 1, character: before[before.length - 1].length } };
}
const labels = items => (Array.isArray(items) ? items : items.items).map(i => i.label);
const complete = (a) => conn.sendRequest('textDocument/completion', { textDocument: { uri: a.uri }, position: a.position });

test('member completion: String, List, user class, cascade', async () => {
  let a = await open('package main\n\nmethod f(String text) {\n    text./*|*/\n}\n');
  assert.ok(labels(await complete(a)).includes('toUpperCase'));

  a = await open('package main\n\nmethod f(List<Int> xs) {\n    xs./*|*/\n}\n');
  const l = labels(await complete(a));
  assert.ok(l.includes('add') && l.includes('map') && l.includes('reduce'));

  a = await open('package main\nuse util.Player\n\nmethod f(Player p) {\n    p./*|*/\n}\n');
  const pl = labels(await complete(a));
  assert.ok(pl.includes('describe') && pl.includes('score') && pl.includes('addPoints'), pl.join(','));

  a = await open('package main\nuse util.Player\n\nmethod f {\n    Player p = Player("a", 1)\n        ../*|*/\n}\n');
  assert.ok(labels(await complete(a)).includes('addPoints'));
});

test('result / task members', async () => {
  const a = await open('package main\n\nmethod<Result<Int, IOException>> read {\n    success 1\n}\n\nmethod f {\n    var r = read()\n    r./*|*/\n}\n');
  const l = labels(await complete(a));
  assert.ok(l.includes('orElse') && l.includes('isSuccess') && l.includes('mapError'), l.join(','));
});

test('auto-import completion + unknown-type quick fix', async () => {
  const a = await open('package main\n\nmethod f {\n    Pla/*|*/\n}\n');
  const items = await complete(a);
  const it = items.find(i => i.label === 'Player' && i.additionalTextEdits);
  assert.ok(it, 'Player auto-import item');
  assert.match(it.additionalTextEdits[0].newText, /use util\.Player/);

  const b = await open('package main\n\nmethod f(Player p) {\n}\n');
  const d = (diags.get(b.uri) ?? []).find(x => x.code === 'unknown-type');
  assert.ok(d, JSON.stringify(diags.get(b.uri)));
  const acts = await conn.sendRequest('textDocument/codeAction', { textDocument: { uri: b.uri }, range: d.range, context: { diagnostics: [d] } });
  assert.ok(acts.some(x => x.title === "Import 'util.Player'"), JSON.stringify(acts.map(x => x.title)));
});

test('use completion', async () => {
  let a = await open('package main\nuse util./*|*/\n');
  assert.ok(labels(await complete(a)).includes('Player'));
  a = await open('package main\nuse std.coll/*|*/\n');
  assert.ok(labels(await complete(a)).includes('collections'));
  a = await open('package main\nuse std.collections./*|*/\n');
  assert.ok(labels(await complete(a)).includes('IList'));
});

test('hover, definition, references, signature help', async () => {
  const src = 'package main\nuse util.Player\n\nmethod f {\n    Player/*|*/ p = Player("a", 1)\n    p.addPoints(2)\n}\n';
  const a = await open(src);
  const pos = { line: a.position.line, character: a.position.character - 1 };
  const hv = await conn.sendRequest('textDocument/hover', { textDocument: { uri: a.uri }, position: pos });
  assert.match(hv.contents.value, /class Player/);
  assert.match(hv.contents.value, /A player with a score/);
  const def = await conn.sendRequest('textDocument/definition', { textDocument: { uri: a.uri }, position: pos });
  assert.match(def.uri, /players\.ev$/);
  const refs = await conn.sendRequest('textDocument/references', { textDocument: { uri: a.uri }, position: pos, context: { includeDeclaration: true } });
  assert.ok(refs.length >= 3, 'references: ' + refs.length);

  const s = await open('package main\nuse util.Player\n\nmethod f {\n    Player p = Player(/*|*/)\n}\n');
  const sig = await conn.sendRequest('textDocument/signatureHelp', { textDocument: { uri: s.uri }, position: s.position });
  assert.ok(sig && sig.signatures[0].label.includes('String name'), JSON.stringify(sig));
});

test('diagnostics: syntax, binding and flow', async () => {
  const a = await open('package main\n\nclass Holder {\n    String text { get, set } = null\n}\n\nmethod<Int> len(Holder h) {\n    final var t = h.text\n    return t.length()\n}\n\nmethod g {\n    Int x = "no"\n    if (x > 0 {\n    }\n}\n');
  const msgs = (diags.get(a.uri) ?? []).map(d => d.message).join('\n');
  assert.match(msgs, /'t' may be null; check it first/);
  assert.match(msgs, /expected 'Int', found 'String'/);
  assert.match(msgs, /Expected '\)'/);
});

test('rename is case-insensitive and stays within the symbol', async () => {
  const a = await open('package main\n\nmethod<Int> f {\n    Int cou/*|*/nt = 1\n    COUNT = count + 1\n    return Count\n}\n');
  const ed = await conn.sendRequest('textDocument/rename', { textDocument: { uri: a.uri }, position: a.position, newName: 'total' });
  assert.equal(ed.changes[a.uri].length, 4);
});

test('organize imports removes unused and sorts', async () => {
  const a = await open('package main\nuse util.Level\nuse util.Player\n\nmethod f(Player p) {\n}\n');
  const acts = await conn.sendRequest('textDocument/codeAction', { textDocument: { uri: a.uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: [], only: ['source.organizeImports'] } });
  const org = acts.find(x => x.kind === 'source.organizeImports');
  assert.ok(org);
  assert.equal(org.edit.changes[a.uri][0].newText, 'use util.Player');
});
