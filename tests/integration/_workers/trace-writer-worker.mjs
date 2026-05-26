// Worker script for the multi-process trace race test
// (tests/integration/traces-multi-process.test.ts → bead lhm).
//
// Usage:
//   node trace-writer-worker.mjs <workspacePath> <dbPath> <workerId> <iterations>
//
// Imports from packages/kernel/dist/index.js — REQUIRES `pnpm build` first.
// The test's beforeAll guards this and throws with a clear message if missing.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const kernelDistEntry = resolve(repoRoot, 'packages', 'kernel', 'dist', 'index.js');

const { initDatabase, writeTrace } = await import(kernelDistEntry);

const [, , workspacePath, dbPath, workerId, iterationsStr] = process.argv;
const iterations = Number.parseInt(iterationsStr, 10);

if (!workspacePath || !dbPath || !workerId || Number.isNaN(iterations)) {
  console.error('usage: trace-writer-worker.mjs <workspacePath> <dbPath> <workerId> <iterations>');
  process.exit(2);
}

const dbResult = initDatabase(dbPath);
if (!dbResult.ok) {
  console.error(`worker ${workerId}: initDatabase failed: ${dbResult.error.message}`);
  process.exit(3);
}
const db = dbResult.value;

let written = 0;
for (let i = 0; i < iterations; i += 1) {
  const result = writeTrace(db, workspacePath, 'race.test', {
    worker: workerId,
    iteration: i,
  });
  if (!result.ok) {
    console.error(`worker ${workerId} iter ${i}: writeTrace failed: ${result.error.message}`);
    process.exit(4);
  }
  written += 1;
}

console.log(`worker=${workerId} written=${written}`);
process.exit(0);
