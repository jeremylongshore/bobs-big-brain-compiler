/**
 * Tests for the promotion engine (promotion.ts).
 *
 * Each test creates a fresh temporary workspace via `initWorkspace` and an
 * in-memory SQLite database via `initDatabase(':memory:')`. The workspace
 * fixture includes the complete directory tree required by the kernel
 * (outputs/, wiki/topics/, wiki/concepts/, etc., audit/).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promoteArtifact, PromotionError, VALID_PROMOTION_TYPES } from './promotion.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

/** Creates a file at `absolutePath` with the given content (creates parent dirs). */
function writeFile(absolutePath: string, content: string): void {
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

/** Returns a markdown file with valid YAML frontmatter containing a `title`. */
function validArtifactContent(title = 'Test Artifact'): string {
  return [
    '---',
    `title: ${title}`,
    'type: topic',
    '---',
    '',
    '# Body',
    '',
    'Content goes here.',
    '',
  ].join('\n');
}

/** Absolute path to a valid fixture file under outputs/reports/. */
function artifactPath(filename = 'my-artifact.md'): string {
  return resolve(workspacePath, 'outputs', 'reports', filename);
}

/** Creates a valid artifact at `outputs/reports/<filename>` and returns its absolute path. */
function createArtifact(filename = 'my-artifact.md', title = 'Test Artifact'): string {
  const path = artifactPath(filename);
  writeFile(path, validArtifactContent(title));
  return path;
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-promotion-test-'));

  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  workspacePath = wsResult.value.root;

  // initWorkspace creates the full directory tree, including outputs/ and wiki/.
  // The DB path is within .ico/ but we use ':memory:' for tests so migrations
  // are always applied from the migrations directory.
  const dbResult = initDatabase(':memory:');
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  const base = resolve(workspacePath, '..');
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Successful promotion
// ---------------------------------------------------------------------------

describe('promoteArtifact — successful promotion', () => {
  it('returns ok(PromotionResult) for a valid artifact', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.value;
    expect(r.promotionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(r.sourcePath).toBe('outputs/reports/my-artifact.md');
    expect(r.targetPath).toMatch(/^wiki\/topics\//);
    expect(r.targetPath).toMatch(/\.md$/);
    expect(r.targetType).toBe('topic');
    expect(r.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('places the promoted file in the correct wiki subdirectory for each type', () => {
    for (const type of VALID_PROMOTION_TYPES) {
      const filename = `artifact-${type}.md`;
      createArtifact(filename, `Artifact For ${type}`);

      const result = promoteArtifact(db, workspacePath, {
        sourcePath: `outputs/reports/${filename}`,
        targetType: type,
        confirm: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const dirMap: Record<string, string> = {
        topic: 'wiki/topics',
        concept: 'wiki/concepts',
        entity: 'wiki/entities',
        reference: 'wiki/sources',
      };

      expect(result.value.targetPath).toMatch(new RegExp(`^${dirMap[type]}/`));
    }
  });

  it('slugifies the title correctly for the target filename', () => {
    writeFile(artifactPath('special.md'), validArtifactContent('Hello World & TypeScript!'));

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/special.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Slug: "hello-world-typescript"
    expect(result.value.targetPath).toBe('wiki/topics/hello-world-typescript.md');
  });
});

// ---------------------------------------------------------------------------
// Rule 1: Only outputs/ is eligible
// ---------------------------------------------------------------------------

describe('promoteArtifact — ineligible source path', () => {
  it('rejects a path not under workspace/outputs/', () => {
    const path = resolve(workspacePath, 'wiki/topics/some-page.md');
    writeFile(path, validArtifactContent());

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'wiki/topics/some-page.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(PromotionError);
    expect(result.error.code).toBe('INELIGIBLE_PATH');
  });

  it('rejects an absolute path outside the workspace entirely', () => {
    const result = promoteArtifact(db, workspacePath, {
      sourcePath: '/tmp/some-random-file.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INELIGIBLE_PATH');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: File must exist
// ---------------------------------------------------------------------------

describe('promoteArtifact — file not found', () => {
  it('rejects a non-existent source file', () => {
    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/does-not-exist.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FILE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: File must be non-empty
// ---------------------------------------------------------------------------

describe('promoteArtifact — empty file', () => {
  it('rejects a zero-byte file', () => {
    const path = artifactPath('empty.md');
    writeFile(path, '');

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/empty.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_FILE');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Frontmatter with title required
// ---------------------------------------------------------------------------

describe('promoteArtifact — missing frontmatter', () => {
  it('rejects a file with no YAML frontmatter block', () => {
    writeFile(artifactPath('no-fm.md'), '# Just a heading\n\nNo frontmatter here.');

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/no-fm.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSING_FRONTMATTER');
  });

  it('rejects a file with frontmatter but no title field', () => {
    writeFile(artifactPath('no-title.md'), '---\ntype: topic\nauthor: Alice\n---\n\n# Body\n');

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/no-title.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSING_FRONTMATTER');
  });

  it('rejects a file with an empty title field', () => {
    writeFile(artifactPath('empty-title.md'), '---\ntitle: "   "\ntype: topic\n---\n\n# Body\n');

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/empty-title.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSING_FRONTMATTER');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: targetType must be valid
// ---------------------------------------------------------------------------

describe('promoteArtifact — invalid target type', () => {
  it('rejects an unrecognised targetType', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'summary' as never,
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TYPE');
  });
});

// ---------------------------------------------------------------------------
// Rule 6/7: Confirmation required / no automatic promotion
// ---------------------------------------------------------------------------

describe('promoteArtifact — confirmation required', () => {
  it('rejects when confirm is false', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
// Target path collision
// ---------------------------------------------------------------------------

describe('promoteArtifact — target path collision', () => {
  it('rejects when the computed target path already exists', () => {
    createArtifact('first.md', 'Collision Test');
    createArtifact('second.md', 'Collision Test'); // same title → same slug → collision

    // Promote the first file successfully.
    const first = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/first.md',
      targetType: 'topic',
      confirm: true,
    });
    expect(first.ok).toBe(true);

    // Attempt to promote the second file with the same title.
    const second = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/second.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('TARGET_EXISTS');
  });
});

// ---------------------------------------------------------------------------
// Anti-pattern: task draft rejection
// ---------------------------------------------------------------------------

describe('promoteArtifact — anti-pattern: task draft', () => {
  it('rejects a path that contains tasks/ and drafts/', () => {
    // Even though tasks/ is not under outputs/, the path check for outputs/ runs
    // first. We need a path that passes the outputs/ check but also has tasks/
    // and drafts/ in it. We simulate this with a deeply nested outputs path.
    const draftPath = resolve(workspacePath, 'outputs', 'tasks', 'abc123', 'drafts', 'my-draft.md');
    writeFile(draftPath, validArtifactContent('Draft Report'));

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/tasks/abc123/drafts/my-draft.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DRAFT_REJECTED');
  });
});

// ---------------------------------------------------------------------------
// Anti-pattern: task evidence rejection
// ---------------------------------------------------------------------------

describe('promoteArtifact — anti-pattern: task evidence', () => {
  it('rejects a path that contains tasks/ and evidence/', () => {
    const evidencePath = resolve(
      workspacePath,
      'outputs',
      'tasks',
      'abc123',
      'evidence',
      'screenshot.md',
    );
    writeFile(evidencePath, validArtifactContent('Evidence Page'));

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/tasks/abc123/evidence/screenshot.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVIDENCE_REJECTED');
  });
});

// ---------------------------------------------------------------------------
// Copy-not-move verification
// ---------------------------------------------------------------------------

describe('promoteArtifact — copy not move', () => {
  it('source file still exists after a successful promotion', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const absoluteSource = resolve(workspacePath, 'outputs/reports/my-artifact.md');
    expect(existsSync(absoluteSource)).toBe(true);
  });

  it('target file exists after a successful promotion', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const absoluteTarget = resolve(workspacePath, result.value.targetPath);
    expect(existsSync(absoluteTarget)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter mutation on target
// ---------------------------------------------------------------------------

describe('promoteArtifact — frontmatter mutation', () => {
  it('injects promoted_from, promoted_at, and promoted_by into the target file', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const absoluteTarget = resolve(workspacePath, result.value.targetPath);
    const raw = readFileSync(absoluteTarget, 'utf-8');

    expect(raw).toContain('promoted_from');
    expect(raw).toContain('outputs/reports/my-artifact.md');
    expect(raw).toContain('promoted_at');
    expect(raw).toContain('promoted_by');
    expect(raw).toContain('user');
  });

  it('does NOT mutate the source file frontmatter', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const absoluteSource = resolve(workspacePath, 'outputs/reports/my-artifact.md');
    const raw = readFileSync(absoluteSource, 'utf-8');

    expect(raw).not.toContain('promoted_from');
    expect(raw).not.toContain('promoted_at');
    expect(raw).not.toContain('promoted_by');
  });
});

// ---------------------------------------------------------------------------
// DB record verification
// ---------------------------------------------------------------------------

describe('promoteArtifact — database record', () => {
  it('inserts a row into the promotions table', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db
      .prepare<
        [string],
        {
          id: string;
          source_path: string;
          target_path: string;
          target_type: string;
          promoted_by: string;
          source_hash: string | null;
        }
      >(
        'SELECT id, source_path, target_path, target_type, promoted_by, source_hash FROM promotions WHERE id = ?',
      )
      .get(result.value.promotionId);

    expect(row).toBeDefined();
    expect(row!.id).toBe(result.value.promotionId);
    expect(row!.source_path).toBe('outputs/reports/my-artifact.md');
    expect(row!.target_path).toBe(result.value.targetPath);
    expect(row!.target_type).toBe('topic');
    expect(row!.promoted_by).toBe('user');
    expect(row!.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('promoted_by is always "user"', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db
      .prepare<[string], { promoted_by: string }>('SELECT promoted_by FROM promotions WHERE id = ?')
      .get(result.value.promotionId);

    expect(row!.promoted_by).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Trace verification
// ---------------------------------------------------------------------------

describe('promoteArtifact — trace event', () => {
  it('writes a trace event of type "promotion"', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const traces = readTraces(db, { eventType: 'promotion' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    expect(traces.value).toHaveLength(1);
    expect(traces.value[0]!.event_type).toBe('promotion');
  });

  it('trace summary references the source and target paths', () => {
    createArtifact();

    promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    const traces = readTraces(db, { eventType: 'promotion' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    const summary = traces.value[0]!.summary ?? '';
    expect(summary).toContain('outputs/reports/my-artifact.md');
  });
});

// ---------------------------------------------------------------------------
// Audit file verification
// ---------------------------------------------------------------------------

describe('promoteArtifact — audit file', () => {
  it('creates a JSONL file at audit/promotions/<promotionId>.jsonl', () => {
    createArtifact();

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const auditFile = resolve(
      workspacePath,
      'audit',
      'promotions',
      `${result.value.promotionId}.jsonl`,
    );

    expect(existsSync(auditFile)).toBe(true);

    const raw = readFileSync(auditFile, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['promotionId']).toBe(result.value.promotionId);
    expect(parsed['sourcePath']).toBe('outputs/reports/my-artifact.md');
    expect(parsed['targetPath']).toBe(result.value.targetPath);
    expect(parsed['targetType']).toBe('topic');
    expect(parsed['promotedBy']).toBe('user');
    expect(parsed['sourceHash']).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// sourceHash correctness
// ---------------------------------------------------------------------------

describe('promoteArtifact — sourceHash', () => {
  it('sourceHash matches the SHA-256 of the source file', () => {
    createArtifact();

    const absoluteSource = resolve(workspacePath, 'outputs/reports/my-artifact.md');

    const result = promoteArtifact(db, workspacePath, {
      sourcePath: 'outputs/reports/my-artifact.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rawBytes = readFileSync(absoluteSource);
    const expectedHash = 'sha256:' + createHash('sha256').update(rawBytes).digest('hex');

    expect(result.value.sourceHash).toBe(expectedHash);
  });
});
