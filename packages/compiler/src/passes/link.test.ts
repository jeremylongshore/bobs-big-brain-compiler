/**
 * Tests for the link (backlink) compilation pass.
 *
 * Uses a real temporary workspace and SQLite database. The link pass is
 * deterministic — no Claude API calls are made, but the ClaudeClient
 * parameter is required for interface consistency.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace, readTraces } from '@ico/kernel';

import type { ClaudeClient } from '../api/claude-client.js';
import { addBacklinks } from './link.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Page A references page B via [[knowledge-compilation]]. */
const PAGE_A_CONTENT = `---
type: concept
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Semantic Graph
---

A semantic graph links concepts together. See also [[knowledge-compilation]].
`;

/** Page B has no outgoing references initially. */
const PAGE_B_CONTENT = `---
type: concept
id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff
title: Knowledge Compilation
---

Knowledge compilation transforms raw sources into structured knowledge.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stub ClaudeClient — the link pass does not call the API. */
function stubClient(): ClaudeClient {
  return {
    createCompletion: vi.fn().mockRejectedValue(new Error('Should not be called')),
  };
}

interface TestEnv {
  wsRoot: string;
  dbPath: string;
  db: Database;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('addBacklinks', () => {
  let env: TestEnv;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-link-base-'));
    const wsResult = initWorkspace('ws', base);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    const { root: wsRoot, dbPath } = wsResult.value;
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    env = { wsRoot, dbPath, db: dbResult.value };

    // Pre-create wiki/concepts/ with two pages.
    const conceptsDir = join(wsRoot, 'wiki', 'concepts');
    mkdirSync(conceptsDir, { recursive: true });
    writeFileSync(join(conceptsDir, 'semantic-graph.md'), PAGE_A_CONTENT, 'utf-8');
    writeFileSync(join(conceptsDir, 'knowledge-compilation.md'), PAGE_B_CONTENT, 'utf-8');
  });

  afterEach(() => {
    closeDatabase(env.db);
    rmSync(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Empty wiki → returns ok with zero counts
  // -------------------------------------------------------------------------

  it('returns ok with pagesUpdated=0 when wiki/ is empty', async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), 'ico-link-empty-'));
    const wsResult = initWorkspace('ws', emptyBase);
    if (!wsResult.ok) throw wsResult.error;
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const emptyDb = dbResult.value;

    try {
      const result = await addBacklinks(stubClient(), emptyDb, wsResult.value.root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pagesUpdated).toBe(0);
      expect(result.value.totalBacklinks).toBe(0);
    } finally {
      closeDatabase(emptyDb);
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Backlinks section added to referenced page
  // -------------------------------------------------------------------------

  it('appends a ## Backlinks section to the referenced page', async () => {
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const knowledgePage = readFileSync(
      join(env.wsRoot, 'wiki', 'concepts', 'knowledge-compilation.md'),
      'utf-8',
    );
    expect(knowledgePage).toContain('## Backlinks');
    expect(knowledgePage).toContain('semantic-graph');
  });

  // -------------------------------------------------------------------------
  // 3. Referencing page is not modified
  // -------------------------------------------------------------------------

  it('does not add a backlinks section to pages with no incoming links', async () => {
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const semanticGraph = readFileSync(
      join(env.wsRoot, 'wiki', 'concepts', 'semantic-graph.md'),
      'utf-8',
    );
    expect(semanticGraph).not.toContain('## Backlinks');
  });

  // -------------------------------------------------------------------------
  // 4. pagesUpdated and totalBacklinks counts correct
  // -------------------------------------------------------------------------

  it('returns correct pagesUpdated and totalBacklinks counts', async () => {
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesUpdated).toBe(1);
    expect(result.value.totalBacklinks).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. Idempotent: re-running does not duplicate backlinks
  // -------------------------------------------------------------------------

  it('is idempotent — running twice does not duplicate the backlinks section', async () => {
    await addBacklinks(stubClient(), env.db, env.wsRoot);
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = readFileSync(
      join(env.wsRoot, 'wiki', 'concepts', 'knowledge-compilation.md'),
      'utf-8',
    );
    // Count occurrences of the section marker.
    const occurrences = (content.match(/## Backlinks/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Trace event written
  // -------------------------------------------------------------------------

  it('writes a compile.link trace event when pages are updated', async () => {
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tracesResult = readTraces(env.db, { eventType: 'compile.link' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;
    expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Audit log updated
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(env.wsRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('compile.link');
  });

  // -------------------------------------------------------------------------
  // 8. Claude client is never called
  // -------------------------------------------------------------------------

  it('never calls the Claude API (deterministic pass)', async () => {
    const client = stubClient();
    await addBacklinks(client, env.db, env.wsRoot);
    expect((client.createCompletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. Multiple referrers in the backlinks section
  // -------------------------------------------------------------------------

  it('lists all referrers in the backlinks section', async () => {
    // Add a second page that also references knowledge-compilation.
    const conceptsDir = join(env.wsRoot, 'wiki', 'concepts');
    writeFileSync(
      join(conceptsDir, 'another-page.md'),
      `---
type: concept
id: cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa
title: Another Page
---

This also links to [[knowledge-compilation]].
`,
      'utf-8',
    );

    const result = await addBacklinks(stubClient(), env.db, env.wsRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalBacklinks).toBe(2);

    const content = readFileSync(
      join(env.wsRoot, 'wiki', 'concepts', 'knowledge-compilation.md'),
      'utf-8',
    );
    expect(content).toContain('semantic-graph');
    expect(content).toContain('another-page');
  });
});
