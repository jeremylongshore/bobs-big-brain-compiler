// Worker script for the promotion crash-window fault-injection test
// (tests/integration/promotion-crash.test.ts → GSB G1).
//
// Usage:
//   node promotion-crash-worker.mjs <workspacePath> <dbPath>
//
// The crash phase is injected by the PARENT via the ICO_CRASH_AFTER env var
// (see packages/kernel/src/crash-hook.ts): the kernel SIGKILLs itself at the
// named phase inside promoteArtifact's write path. When no phase is set the
// promotion completes and this worker exits 0.
//
// Imports from packages/kernel/dist/index.js — REQUIRES `pnpm build` first.
// The test's beforeAll guards this and throws with a clear message if missing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const kernelDistEntry = resolve(repoRoot, 'packages', 'kernel', 'dist', 'index.js');

const { initDatabase, promoteArtifact } = await import(kernelDistEntry);

const [, , workspacePath, dbPath] = process.argv;
if (!workspacePath || !dbPath) {
  console.error('usage: promotion-crash-worker.mjs <workspacePath> <dbPath>');
  process.exit(2);
}

// Plant a promotable artifact in outputs/reports/.
const artifactRel = join('outputs', 'reports', 'crash-artifact.md');
const artifactAbs = join(workspacePath, artifactRel);
mkdirSync(dirname(artifactAbs), { recursive: true });
writeFileSync(artifactAbs, '---\ntitle: Crash Artifact\n---\n\nPromotable body.\n', 'utf-8');

const dbResult = initDatabase(dbPath);
if (!dbResult.ok) {
  console.error(`worker: initDatabase failed: ${dbResult.error.message}`);
  process.exit(3);
}

const result = promoteArtifact(dbResult.value, workspacePath, {
  sourcePath: artifactRel,
  targetType: 'topic',
  confirm: true,
});

// Only reached when ICO_CRASH_AFTER did not fire.
if (!result.ok) {
  console.error(`worker: promoteArtifact failed: ${result.error.message}`);
  process.exit(4);
}
console.log(JSON.stringify({ targetPath: result.value.targetPath }));
process.exit(0);
