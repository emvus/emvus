// Runs the extension's front end (parser + checker) against the language tests in Ring0/tests.
//   tests/syntax/n*.ev   // expect: <fragment>@<line>   (must be reported at that line)
//   tests/syntax/p*.ev   // expect-ok                   (no errors)
//   tests/binding/*.ev   // expect: <fragment>          (reported somewhere)
//   tests/flow/*.ev      // expect: <fragment> | check ok
//   tests/showcase.ev    -> check ok
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { analyze } = require(path.join(here, '..', 'dist', 'spec.cjs'));
const tests = process.env.EMVUS_TESTS || path.join(here, '..', '..', 'Ring0', 'tests');

const list = d => fs.readdirSync(path.join(tests, d)).filter(f => f.endsWith('.ev')).sort();
const errorsOf = (text, semantic = true) => analyze(text, { semantic }).filter(f => f.severity === 'error');
const show = errs => errs.map(e => `${e.line}:${e.col} ${e.message}`).join('\n    ');

for (const f of list('syntax')) {
  test(`syntax/${f}`, () => {
    const text = fs.readFileSync(path.join(tests, 'syntax', f), 'utf8');
    const errs = errorsOf(text, false); // syntax tests only exercise the parser
    if (text.includes('// expect-ok')) return assert.deepEqual(errs, [], 'expected no errors:\n    ' + show(errs));
    assert.ok(errs.length > 0, 'expected errors');
    for (const m of text.matchAll(/^\/\/ expect: (.*)@(\d+)$/gm)) {
      assert.ok(errs.some(e => e.line === +m[2] && e.message.includes(m[1])), `missing "${m[1]}" @${m[2]}; got:\n    ${show(errs)}`);
    }
  });
}

for (const dir of ['binding', 'flow']) {
  for (const f of list(dir)) {
    test(`${dir}/${f}`, () => {
      const text = fs.readFileSync(path.join(tests, dir, f), 'utf8');
      const expect = text.split('\n')[0].replace(/^\/\/ expect: /, '').trim();
      const errs = errorsOf(text);
      if (expect === 'check ok') return assert.deepEqual(errs, [], 'expected "check ok":\n    ' + show(errs));
      assert.ok(errs.some(e => e.message.includes(expect)), `expected "${expect}"; got:\n    ${show(errs) || '(no errors)'}`);
    });
  }
}

test('showcase.ev checks ok', () => {
  const text = fs.readFileSync(path.join(tests, 'showcase.ev'), 'utf8');
  const errs = errorsOf(text);
  assert.deepEqual(errs, [], '\n    ' + show(errs));
});
