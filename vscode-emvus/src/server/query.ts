// AST queries used by the language server: node lookup, scopes, docs.
import { Node, walk } from './ast';
import { FileModel } from './model';

/** Path of nodes from the root down to the deepest node containing `offset`. */
export function pathAt(root: Node, offset: number): Node[] {
  const path: Node[] = [];
  let cur: Node | undefined = root;
  while (cur) {
    path.push(cur);
    let next: Node | undefined;
    for (const c of cur.children) {
      if (c.start <= offset && offset <= c.end && c.end > c.start) {
        // prefer the narrowest child
        if (!next || (c.end - c.start) <= (next.end - next.start)) next = c;
      }
    }
    cur = next;
  }
  return path;
}

export interface LocalVar {
  name: string;
  type: string;
  node: Node;
  kind: 'param' | 'local' | 'lambda' | 'foreach' | 'binding';
}

const typeText = (n: Node | undefined): string => {
  if (!n) return '';
  if (n.kind === 'tuple-type') return `[${n.children.map(typeText).join(', ')}]`;
  if (n.kind !== 'type') return '';
  const args = n.children.filter(c => c.kind === 'type' || c.kind === 'tuple-type');
  return args.length ? `${n.text}<${args.map(typeText).join(', ')}>` : n.text;
};
export { typeText };

/** Variables visible at `offset` (parameters, earlier locals, loop variables, pattern bindings). */
export function localsAt(root: Node, offset: number): LocalVar[] {
  const path = pathAt(root, offset);
  const out: LocalVar[] = [];
  const addParams = (params: Node | undefined) => {
    for (const p of params?.children ?? []) {
      if (p.kind !== 'param') continue;
      out.push({ name: p.text, type: typeText(p.children.find(c => c.kind === 'type' || c.kind === 'tuple-type')), node: p, kind: 'param' });
    }
  };
  for (const n of path) {
    switch (n.kind) {
      case 'method': case 'constructor': case 'macro':
        addParams(n.children.find(c => c.kind === 'params'));
        if (n.kind === 'macro') out.push({ name: 'target', type: '', node: n, kind: 'param' });
        break;
      case 'lambda': addParams(n.children[0]); break;
      case 'block':
        for (const s of n.children) {
          if (s.start >= offset) break;
          if (s.kind === 'local') out.push({ name: s.text, type: typeText(s.children.find(c => c.kind === 'type')), node: s, kind: 'local' });
          if (s.kind === 'destructure') for (const b of s.children) if (b.kind === 'binding') out.push({ name: b.text, type: '', node: b, kind: 'binding' });
        }
        break;
      case 'foreach':
        out.push({ name: n.text, type: typeText(n.children.find(c => c.kind === 'type')), node: n, kind: 'foreach' });
        break;
      case 'for': {
        const init = n.children[0];
        for (const s of init?.children ?? []) if (s.kind === 'local') out.push({ name: s.text, type: typeText(s.children.find(c => c.kind === 'type')), node: s, kind: 'local' });
        break;
      }
      case 'case':
        for (const pat of n.children) {
          for (const b of pat.children) if (b.kind === 'binding') out.push({ name: b.text, type: '', node: b, kind: 'binding' });
        }
        break;
      default: break;
    }
  }
  return out;
}

export function enclosingType(root: Node, offset: number): Node | undefined {
  const path = pathAt(root, offset);
  for (let i = path.length - 1; i >= 0; i--) {
    if (['class', 'data-class', 'record', 'interface', 'exception', 'enum'].includes(path[i].kind)) return path[i];
  }
  return undefined;
}

export function insideMember(root: Node, offset: number): Node | undefined {
  const path = pathAt(root, offset);
  for (let i = path.length - 1; i >= 0; i--) if (['method', 'constructor', 'macro'].includes(path[i].kind)) return path[i];
  return undefined;
}

/** Contiguous `//` comment lines directly above the line holding `offset`. */
export function docAbove(file: FileModel, offset: number): string {
  const lines = file.text.split('\n');
  const starts = file.parse.lineStarts;
  let line = 0;
  for (let i = 0; i < starts.length; i++) { if (starts[i] <= offset) line = i; else break; }
  const out: string[] = [];
  let l = line - 1;
  while (l >= 0) {
    const s = lines[l].trim();
    if (s.startsWith('@')) { l--; continue; }
    if (s.startsWith('//')) { out.unshift(s.replace(/^\/\/\s?/, '')); l--; } else break;
  }
  return out.join('\n');
}

export function collectNodes(root: Node, pred: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  walk(root, n => { if (pred(n)) out.push(n); });
  return out;
}
