import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const compilerRequire = createRequire(
  new URL('../../packages/compiler/package.json', import.meta.url),
);

describe.skipIf(process.platform === 'win32')(
  'installed SDK optional memory-helper permission regression',
  () => {
    it('creates private directories/files with a permissive child-only umask', () => {
      // GHSA-p7fg-763f-g4gf. This helper is not part of the owned messages.create
      // product path; exercise the actual installed package without adding it there.
      const root = mkdtempSync(join(tmpdir(), 'bbb-compiler-sdk-memory-root-'));
      const parentMask = process.umask();
      try {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./_workers/sdk-memory-worker.mjs', import.meta.url)),
            compilerRequire.resolve('@anthropic-ai/sdk/tools/memory/node.mjs'),
            root,
          ],
          { encoding: 'utf8', timeout: 5_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr || result.stdout).toBe(0);
        const report = JSON.parse(result.stdout) as {
          checks: Array<{ name: string; expected: string; actual: string; pass: boolean }>;
          functionalControlsPassed: boolean;
        };
        expect(report.checks).toHaveLength(5);
        for (const check of report.checks) expect(check.actual, check.name).toBe(check.expected);
        expect(report.functionalControlsPassed).toBe(true);
        expect(process.umask()).toBe(parentMask);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
