import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const environment = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
for (const [args, cwd] of [
  [['scripts/check.mjs'], root],
  [['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.compute.config.ts'], path.join(root, 'apps/web')],
]) {
  const result = spawnSync(process.execPath, args, { cwd, env: environment, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('PASS model-task client/build and Chrome with explicit API/model/ledger substitutes; real model and financial facts are a separate server acceptance');
