import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.js' },
  { ...common, entryPoints: ['src/spec.ts'], outfile: 'dist/spec.cjs' },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  for (const c of configs) await build(c);
}
