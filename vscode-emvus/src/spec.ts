// Entry used by test/spec.test.mjs: parse (+ check) one source text.
import { checkFile } from './server/checker';
import { Project } from './server/model';

export function analyze(text: string, opts: { semantic?: boolean } = {}) {
  const project = new Project();
  const file = project.setFile('file:///spec.ev', text);
  const syntax = file.parse.diagnostics.map(d => ({
    line: d.line, col: d.col, message: d.message, severity: d.severity as string,
  }));
  if (opts.semantic === false) return syntax;
  const semantic = checkFile(project, file).map(f => ({ line: f.line, col: f.col, message: f.message, severity: f.severity as string }));
  return [...syntax, ...semantic];
}
