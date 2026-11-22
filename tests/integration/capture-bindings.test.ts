import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runIngest } from '../../packages/cli/src/commands/ingest.js';
import * as lock from '../../packages/cli/src/lib/write-lock.js';
import * as adapters from '../../packages/compiler/src/adapters/registry.js';
import { runIngestPipeline } from '../../packages/compiler/src/ingest-pipeline.js';
import {
  closeDatabase,
  initDatabase,
  initWorkspace,
  readSourceCaptureBindings,
} from '../../packages/kernel/src/index.js';

function snapshot(root: string): unknown {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      entry.isDirectory()
        ? [entry.name, snapshot(join(root, entry.name))]
        : [entry.name, readFileSync(join(root, entry.name)).toString('base64')],
    );
}

describe('actual ingestion capture binding', () => {
  let base: string;
  let workspace: string;
  let dbPath: string;
  let catalogPath: string;
  let roots: string[];
  let catalog: { version: number; id: string; revision: number; roots: unknown[] };
  const save = () => writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  const input = (index: number) => join(roots[index]!, 'same.txt');
  async function invoke(gateway: 'cli' | 'library', path: string, tracked = true) {
    if (gateway === 'cli') {
      vi.stubEnv('ICO_SOURCE_CATALOG', tracked ? catalogPath : undefined);
      return runIngest(path, {}, { workspace });
    }
    return runIngestPipeline(path, {
      workspacePath: workspace,
      dbPath,
      ...(tracked && { captureCatalogPath: catalogPath }),
    });
  }
  function bindings() {
    const opened = initDatabase(dbPath);
    if (!opened.ok) throw opened.error;
    try {
      const rows = opened.value.prepare('SELECT id,hash FROM sources').all() as Array<{
        id: string;
        hash: string;
      }>;
      return rows.map((row) =>
        readSourceCaptureBindings(opened.value, row.id, row.hash, catalogPath),
      );
    } finally {
      closeDatabase(opened.value);
    }
  }
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bbb-capture-integration-'));
    const initialized = initWorkspace('workspace', base);
    if (!initialized.ok) throw initialized.error;
    workspace = initialized.value.root;
    dbPath = initialized.value.dbPath;
    const opened = initDatabase(dbPath);
    if (!opened.ok) throw opened.error;
    closeDatabase(opened.value);
    roots = ['alpha', 'beta'].map((name) => {
      const path = join(base, name);
      mkdirSync(path);
      return path;
    });
    catalog = {
      version: 1,
      id: 'synthetic',
      revision: 1,
      roots: roots.map((path, i) => {
        const st = statSync(path, { bigint: true });
        return {
          id: `root-${i}`,
          path,
          device: String(st.dev),
          inode: String(st.ino),
          repositoryId: `repo-${i}`,
          profileId: `profile-${i}`,
          profileRevision: 1,
          profileDigest: createHash('sha256').update(`profile-${i}`).digest('hex'),
        };
      }),
    };
    catalogPath = join(base, 'catalog.json');
    save();
    for (let i = 0; i < 2; i++) writeFileSync(input(i), 'Identical neutral source bytes');
    vi.stubEnv('TEAMKB_HOME', join(base, 'isolated-lock'));
    vi.stubEnv('TEAMKB_LOCK', join(base, 'isolated-lock', '.write.lock'));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it.each(['cli', 'library'] as const)(
    '%s preserves both approved roots across real deduplication',
    async (gateway) => {
      expect((await invoke(gateway, input(0))).ok).toBe(true);
      const duplicate = await invoke(gateway, input(1));
      if (!duplicate.ok) throw duplicate.error;
      expect(duplicate.value.alreadyIngested).toBe(true);
      const recorded = bindings();
      expect(recorded).toHaveLength(1);
      if (!recorded[0]!.ok) throw recorded[0]!.error;
      expect(recorded[0]!.value.map((r) => r.profileId).sort()).toEqual(['profile-0', 'profile-1']);
    },
  );

  it.each(['cli', 'library'] as const)(
    '%s cannot launder earlier unknown provenance with a trusted duplicate',
    async (gateway) => {
      expect((await invoke(gateway, input(0), false)).ok).toBe(true);
      expect((await invoke(gateway, input(1))).ok).toBe(true);
      expect(bindings().map((r) => r.ok)).toEqual([false]);
    },
  );

  it.each(['cli', 'library'] as const)(
    '%s refuses an unenrolled source without workspace changes',
    async (gateway) => {
      const outside = join(base, 'outside.txt');
      writeFileSync(outside, 'Neutral source');
      const before = snapshot(workspace);
      expect((await invoke(gateway, outside)).ok).toBe(false);
      expect(snapshot(workspace)).toEqual(before);
    },
  );

  it.each(['cli', 'library'] as const)(
    '%s refuses catalog drift before persistence',
    async (gateway) => {
      const before = snapshot(workspace);
      if (gateway === 'cli') {
        const original = lock.withBrainWriteLock;
        vi.spyOn(lock, 'withBrainWriteLock').mockImplementation(async (fn) => {
          catalog.revision++;
          save();
          return original(fn);
        });
      } else {
        const original = adapters.ingestSource;
        vi.spyOn(adapters, 'ingestSource').mockImplementation(async (...args) => {
          const result = await original(...args);
          catalog.revision++;
          save();
          return result;
        });
      }
      expect((await invoke(gateway, input(0))).ok).toBe(false);
      expect(snapshot(workspace)).toEqual(before);
    },
  );
});
