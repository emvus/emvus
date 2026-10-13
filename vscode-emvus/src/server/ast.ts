// Uniform AST node, same idea as ring0's Node(kind, text, children) — see Ring0/AST.md.
export interface Node {
  kind: string;
  text: string;
  children: Node[];
  start: number; // offset of first token
  end: number; // offset after last token
  line: number; // 1-based line of first token
  col: number;
  nameStart?: number; // range of the declared / referenced name token
  nameEnd?: number;
}

export function mk(kind: string, text: string, start: number, end: number, line: number, col: number, children: Node[] = []): Node {
  return { kind, text, children, start, end, line, col };
}

export function child(n: Node, kind: string): Node | undefined {
  return n.children.find(c => c.kind === kind);
}

export function childrenOf(n: Node, kind: string): Node[] {
  return n.children.filter(c => c.kind === kind);
}

export function walk(n: Node, f: (n: Node, parent: Node | null) => void, parent: Node | null = null) {
  f(n, parent);
  for (const c of n.children) walk(c, f, n);
}
