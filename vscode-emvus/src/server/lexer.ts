// Tokenizer for Emvus (.ev), mirrors ring0/syntax/lexing/*.ems.
// Never aborts: problems are collected as lexer errors.

export type TokenKind = 'id' | 'kw' | 'int' | 'float' | 'string' | 'sym' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string; // raw source text
  start: number;
  end: number;
  line: number; // 1-based, like the compiler's diagnostics
  col: number; // 1-based
  nl: boolean; // a line break precedes this token
}

export interface LexError {
  message: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  'package', 'use', 'var', 'dynamic', 'enum', 'record', 'class', 'interface', 'exception', 'method', 'macro',
  'final', 'static', 'abstract', 'override', 'private', 'protected', 'public', 'scoped',
  'if', 'while', 'for', 'in', 'switch', 'return', 'fail', 'break', 'continue',
  'true', 'false', 'null', 'this', 'super', 'is', 'as', 'fiber', 'virtual', 'thread',
]);

const TWO = new Set(['->', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '..', '+=', '-=', '*=', '/=', '%=']);
const ONE = new Set('(){}[];,.=+-*/%!<>@$:?&|'.split(''));

const isLetter = (c: string) => c === '_' || c.toLowerCase() !== c.toUpperCase();
const isDigit = (c: string) => c >= '0' && c <= '9';

export function tokenize(text: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let nl = false;

  const err = (message: string, start: number, end: number, l: number, c: number) =>
    errors.push({ message, start, end, line: l, col: c });
  const push = (kind: TokenKind, start: number, end: number, l: number, ls: number) => {
    tokens.push({ kind, text: text.slice(start, end), start, end, line: l, col: start - ls + 1, nl });
    nl = false;
  };

  /** Copies a `${...}` / `$(...)` verbatim (nested brackets and strings). Returns new index. */
  const skipInterpolation = (from: number): number => {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\n') return j;
      if (c === '"') {
        j++;
        while (j < n && text[j] !== '"' && text[j] !== '\n') {
          if (text[j] === '\\') j++;
          else if (text[j] === '$' && (text[j + 1] === '{' || text[j + 1] === '(')) {
            j = skipInterpolation(j + 1);
            continue;
          }
          j++;
        }
        j++;
        continue;
      }
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      nl = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const s = i;
      const sl = line;
      const sc = i - lineStart + 1;
      i += 2;
      let closed = false;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (text[i] === '\n') {
          line++;
          lineStart = i + 1;
          nl = true;
        }
        i++;
      }
      if (!closed) err('Unterminated block comment', s, Math.min(s + 2, n), sl, sc);
      continue;
    }
    if (isLetter(c)) {
      const s = i;
      while (i < n && (isLetter(text[i]) || isDigit(text[i]))) i++;
      push(KEYWORDS.has(text.slice(s, i)) ? 'kw' : 'id', s, i, line, lineStart);
      continue;
    }
    if (isDigit(c)) {
      const s = i;
      let isFloat = false;
      while (i < n && isDigit(text[i])) i++;
      // `.` starts a fraction only when a digit follows: `1..x`, `1.method()` stay intact
      if (text[i] === '.' && isDigit(text[i + 1] ?? '')) {
        isFloat = true;
        i++;
        while (i < n && isDigit(text[i])) i++;
      }
      // `e` without digits is not an exponent
      if ((text[i] === 'e' || text[i] === 'E')) {
        let j = i + 1;
        if (text[j] === '+' || text[j] === '-') j++;
        if (isDigit(text[j] ?? '')) {
          isFloat = true;
          i = j;
          while (i < n && isDigit(text[i])) i++;
        }
      }
      push(isFloat ? 'float' : 'int', s, i, line, lineStart);
      continue;
    }
    if (c === '"') {
      const s = i;
      const sl = line;
      const ls = lineStart;
      i++;
      let closed = false;
      while (i < n) {
        const d = text[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '$' && (text[i + 1] === '{' || text[i + 1] === '(')) {
          i = skipInterpolation(i + 1);
          continue;
        }
        if (d === '"') {
          i++;
          closed = true;
          break;
        }
        if (d === '\n') break;
        i++;
      }
      if (!closed) err('Unterminated string literal', s, Math.min(i, n), sl, s - ls + 1);
      push('string', s, Math.min(i, n), sl, ls);
      continue;
    }
    if (c === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
      push('sym', i, i + 3, line, lineStart);
      i += 3;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO.has(two)) {
      push('sym', i, i + 2, line, lineStart);
      i += 2;
      continue;
    }
    if (ONE.has(c)) {
      push('sym', i, i + 1, line, lineStart);
      i++;
      continue;
    }
    err(`Unexpected character '${c}'`, i, i + 1, line, i - lineStart + 1);
    i++;
  }
  tokens.push({ kind: 'eof', text: '', start: n, end: n, line, col: n - lineStart + 1, nl: true });
  return { tokens, errors };
}
