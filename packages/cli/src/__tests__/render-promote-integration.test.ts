/**
 * End-to-end integration tests for the render and promote pipeline (E8-B09).
 *
 * All tests exercise the full flow directly via function calls with a mocked
 * ClaudeClient — no subprocess spawning, no real API calls.
 *
 * Each test gets its own temporary workspace directory that is cleaned up in
 * afterEach. The DB is opened against a real `.ico/state.db` file so that
 * the promotions table is available via the standard migrations.
 *
 * @module __tests__/render-promote-integration
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ClaudeClient, renderReport, renderSlides, validateArtifact } from '@ico/compiler';
import {
  closeDatabase,
  type Database,
  initDatabase,
  listArtifacts,
  promoteArtifact,
  PromotionError,
  runPostPromotionRefresh,
  unpromoteArtifact,
} from '@ico/kernel';
import { ok } from '@ico/types';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeClient mock that always resolves with the given content string.
 * Uses vi.fn() so call counts and arguments can be inspected when needed.
 */
function createMockClient(reportContent: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue(
      ok({
        content: reportContent,
        inputTokens: 100,
        outputTokens: 200,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    ),
  } as unknown as ClaudeClient;
}

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const AUDIT_LOG_HEADER = `# ICO Audit Log

| Timestamp | Operation | Summary |
|-----------|-----------|---------|
`;

const TOPIC_FIXTURE = `---
title: "Test Topic"
type: topic
compiled_at: "2026-04-06T10:00:00.000Z"
sources:
  - "raw/test-source.md"
---

# Test Topic

This is a test topic about machine learning fundamentals.
It covers key concepts including neural networks and backpropagation.
`;

// ---------------------------------------------------------------------------
// Per-test workspace setup
// ---------------------------------------------------------------------------

let wsPath: string;
let db: Database;

beforeEach(() => {
  // Create a fresh temp directory for each test.
  wsPath = mkdtempSync(join(tmpdir(), 'ico-rp-int-'));

  // Create all workspace subdirectories expected by the kernel APIs.
  for (const dir of [
    '.ico',
    'wiki/topics',
    'wiki/concepts',
    'wiki/entities',
    'wiki/sources',
    'outputs/reports',
    'outputs/slides',
    'audit',
    'audit/traces',
    'audit/promotions',
    'raw',
  ]) {
    mkdirSync(join(wsPath, dir), { recursive: true });
  }

  // Create the audit log that appendAuditLog requires to exist.
  writeFileSync(join(wsPath, 'audit', 'log.md'), AUDIT_LOG_HEADER, 'utf-8');

  // Initialise the SQLite database with all migrations applied.
  const dbPath = join(wsPath, '.ico', 'state.db');
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    throw new Error(`initDatabase failed: ${dbResult.error.message}`);
  }
  db = dbResult.value;

  // Write the fixture compiled topic page.
  writeFileSync(join(wsPath, 'wiki', 'topics', 'test-topic.md'), TOPIC_FIXTURE, 'utf-8');
});

afterEach(() => {
  closeDatabase(db);
  rmSync(wsPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('render and promote integration', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: Render a report from a compiled topic
  // -------------------------------------------------------------------------

  it('renders a report from compiled topic pages', async () => {
    const mockResponse = `## Executive Summary

This report covers machine learning fundamentals. [source: Test Topic]

## Key Findings

Neural networks use backpropagation for training. [source: Test Topic]

## Evidence and Analysis

The compiled knowledge indicates strong coverage of ML basics. [source: Test Topic]

## Conclusion

The topic provides comprehensive coverage.

## Sources

- Test Topic`;

    const client = createMockClient(mockResponse);
    const sources = [
      {
        title: 'Test Topic',
        content: TOPIC_FIXTURE,
        path: 'topics/test-topic.md',
      },
    ];

    const result = await renderReport(wsPath, sources, { client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // renderReport returns an absolute outputPath.
    expect(existsSync(result.value.outputPath)).toBe(true);

    // Validate the rendered artifact's frontmatter.
    const validation = validateArtifact(result.value.outputPath);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    expect(validation.value.valid).toBe(true);
    expect(validation.value.frontmatter.type).toBe('report');
    expect(typeof validation.value.frontmatter.title).toBe('string');
    expect(validation.value.frontmatter.model).toBe('claude-sonnet-4-6');
    expect(validation.value.frontmatter.tokens_used).toBe(300); // 100 in + 200 out
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Render slides and verify Marp format
  // -------------------------------------------------------------------------

  it('renders Marp-compatible slides', async () => {
    const mockSlides = `# Machine Learning Fundamentals

An overview of key concepts

---

## Neural Networks

- Composed of layers of neurons
- Use activation functions
- Trained via backpropagation

<!-- Speaker notes: Cover basic architecture -->

---

## Summary

Key takeaways from ML fundamentals`;

    const client = createMockClient(mockSlides);
    const sources = [
      {
        title: 'Test Topic',
        content: TOPIC_FIXTURE,
        path: 'topics/test-topic.md',
      },
    ];

    const result = await renderSlides(wsPath, sources, { client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // renderSlides returns a relative outputPath — join with wsPath to verify on disk.
    const absoluteOutputPath = join(wsPath, result.value.outputPath);
    expect(existsSync(absoluteOutputPath)).toBe(true);

    // The rendered file must contain the Marp frontmatter marker.
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(absoluteOutputPath, 'utf-8');
    expect(content).toContain('marp: true');
    expect(content).toContain('---');

    // The mock response has 2 `---` separators → 3 slides.
    expect(result.value.slideCount).toBeGreaterThanOrEqual(3);

    // Validate the artifact frontmatter (slides require marp: true).
    const validation = validateArtifact(absoluteOutputPath);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.value.valid).toBe(true);
    expect(validation.value.frontmatter.type).toBe('slides');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Full render → promote → verify loop
  // -------------------------------------------------------------------------

  it('promotes a rendered report to wiki', async () => {
    // Step 1: Render a report.
    const client = createMockClient(
      '## Executive Summary\n\nTest report.\n\n## Sources\n\n- Test Topic',
    );
    const sources = [
      {
        title: 'Test Topic',
        content: TOPIC_FIXTURE,
        path: 'topics/test-topic.md',
      },
    ];

    const renderResult = await renderReport(wsPath, sources, { client, title: 'Promoted Report' });
    expect(renderResult.ok).toBe(true);
    if (!renderResult.ok) return;

    // Step 2: Compute workspace-relative source path for promotion.
    // renderReport returns an absolute outputPath; strip the workspace prefix.
    const outputRelPath = renderResult.value.outputPath.replace(wsPath + '/', '');

    // Step 3: Promote the artifact.
    const promoteResult = promoteArtifact(db, wsPath, {
      sourcePath: outputRelPath,
      targetType: 'topic',
      confirm: true,
    });
    expect(promoteResult.ok).toBe(true);
    if (!promoteResult.ok) return;

    // Step 4: Verify the promoted file exists in wiki/topics/.
    const targetFile = join(wsPath, promoteResult.value.targetPath);
    expect(existsSync(targetFile)).toBe(true);

    // Step 5: Verify the promotion is tracked in the DB.
    const artifacts = listArtifacts(db, wsPath);
    expect(artifacts.ok).toBe(true);
    if (!artifacts.ok) return;

    const promoted = artifacts.value.find((a) => a.promoted);
    expect(promoted).toBeDefined();
    expect(promoted?.path).toBe(outputRelPath);

    // Step 6: Run post-promotion refresh (wiki index rebuild + lint).
    const refreshResult = runPostPromotionRefresh(
      db,
      wsPath,
      promoteResult.value.targetPath,
      promoteResult.value.sourcePath,
    );
    expect(refreshResult.ok).toBe(true);
    if (!refreshResult.ok) return;

    // A valid promotion has no lint errors.
    expect(refreshResult.value.lintIssues.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 4a: Reject promotion of a file outside outputs/
  // -------------------------------------------------------------------------

  it('rejects promotion of a non-output file (INELIGIBLE_PATH)', () => {
    const result = promoteArtifact(db, wsPath, {
      sourcePath: 'wiki/topics/test-topic.md',
      targetType: 'topic',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(PromotionError);
    expect(result.error.code).toBe('INELIGIBLE_PATH');
  });

  // -------------------------------------------------------------------------
  // Scenario 4b: Reject promotion without confirmation
  // -------------------------------------------------------------------------

  it('rejects promotion without confirmation (NOT_CONFIRMED)', () => {
    // Place a minimal valid artifact in outputs/ so the path passes eligibility.
    const artifactPath = join(wsPath, 'outputs', 'reports', 'test-artifact.md');
    writeFileSync(
      artifactPath,
      '---\ntitle: "Test Artifact"\ntype: report\n---\nContent here.\n',
      'utf-8',
    );

    const result = promoteArtifact(db, wsPath, {
      sourcePath: 'outputs/reports/test-artifact.md',
      targetType: 'concept',
      confirm: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(PromotionError);
    expect(result.error.code).toBe('NOT_CONFIRMED');
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Full render → promote → unpromote loop
  // -------------------------------------------------------------------------

  it('can unpromote a previously promoted artifact', async () => {
    // Step 1: Render a report.
    const client = createMockClient('## Summary\n\nTest content.');
    const renderResult = await renderReport(
      wsPath,
      [{ title: 'Test Topic', content: TOPIC_FIXTURE, path: 'topics/test-topic.md' }],
      { client, title: 'Unpromote Test' },
    );
    expect(renderResult.ok).toBe(true);
    if (!renderResult.ok) return;

    // Step 2: Promote the artifact.
    const outputRelPath = renderResult.value.outputPath.replace(wsPath + '/', '');
    const promoteResult = promoteArtifact(db, wsPath, {
      sourcePath: outputRelPath,
      targetType: 'concept',
      confirm: true,
    });
    expect(promoteResult.ok).toBe(true);
    if (!promoteResult.ok) return;

    const promotedTargetPath = promoteResult.value.targetPath;
    expect(existsSync(join(wsPath, promotedTargetPath))).toBe(true);

    // Step 3: Unpromote.
    const unpromoteResult = unpromoteArtifact(db, wsPath, {
      targetPath: promotedTargetPath,
    });
    expect(unpromoteResult.ok).toBe(true);

    // Step 4: Verify the promoted file is removed from wiki/.
    expect(existsSync(join(wsPath, promotedTargetPath))).toBe(false);

    // Step 5: Verify the original artifact is still in outputs/ (copy-not-move).
    expect(existsSync(renderResult.value.outputPath)).toBe(true);
  });
});
