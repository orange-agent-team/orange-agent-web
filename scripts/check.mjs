import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (!process.version.startsWith('v22.23.2')) throw new Error('Use the pinned Node 22.23.2 toolchain');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = path.join(root, 'apps/web');
const contracts = path.join(root, 'docs/contracts');
const snapshot = JSON.parse(readFileSync(path.join(contracts, 'snapshot.json'), 'utf8'));
for (const [name, entry] of Object.entries(snapshot.files)) {
  const digest = createHash('sha256').update(readFileSync(path.join(contracts, name))).digest('hex');
  if (digest !== entry.sha256) throw new Error(`Contract snapshot changed: ${name}`);
}
const npm = path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const environment = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
for (const script of ['test', 'build']) {
  const result = spawnSync(process.execPath, [npm, 'run', script], { cwd, env: environment, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const dist = path.join(cwd, 'dist');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
const initial = new Set();
function visit(key) { if (initial.has(key)) return; initial.add(key); for (const dep of manifest[key].imports ?? []) visit(dep); }
for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
const chunks = Object.entries(manifest).filter(([, item]) => item.file.endsWith('.js')).map(([key, item]) => ({ file: item.file, bytes: statSync(path.join(dist, item.file)).size, initial: initial.has(key) }));
const report = { initial_js_bytes: chunks.filter(c => c.initial).reduce((sum, c) => sum + c.bytes, 0), largest_chunk_bytes: Math.max(...chunks.map(c => c.bytes)), chunks };
writeFileSync(path.join(dist, 'bundle-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Bundle: initial JS ${report.initial_js_bytes} bytes; largest chunk ${report.largest_chunk_bytes} bytes`);
if (report.largest_chunk_bytes > 500000) throw new Error('JavaScript chunk exceeds 500 kB budget');
