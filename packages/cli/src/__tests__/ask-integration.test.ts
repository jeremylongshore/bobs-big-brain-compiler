/**
 * End-to-end integration tests for `ico lint` (subprocess) and the ask
 * pipeline (direct function calls with a mocked Claude client).
 *
 * Lint tests spawn real child processes against the pre-built `dist/index.js`
 * binary — a build step must have completed before this suite runs.
 *
 * Ask tests exercise `analyzeQuestion`, `generateAnswer`, and `verifyCitations`
 * directly without network calls. A mocked `ClaudeClient` returns canned
 * responses so the suite has no dependency on a real API key.
 *
 * @module __tests__/ask-integration
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClaudeClient } from '@ico/compiler';
import { analyzeQuestion, generateAnswer, verifyCitations } from '@ico/compiler';
import {
  closeDatabase,
  createSearchIndex,
  type Database,
  indexCompiledPages,
  initDatabase,
} from '@ico/kernel';
import { err, ok } from '@ico/types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the pre-built CLI entry point. */
const CLI_PATH = resolve(__dirname, '../../dist/index.js');

// ---------------------------------------------------------------------------
// Subprocess helper (matches the pattern in integration.test.ts)
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke the ico CLI as a child process and return its output.
 *
 * Sets `NO_COLOR=1` so assertions never match ANSI escape sequences.
 *
 * @param args - Arguments to pass after `node dist/index.js`.
 * @param opts - Optional cwd and env overrides.
 */
function run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): RunResult {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock helpers for ask pipeline tests
// ---------------------------------------------------------------------------

/**
 * Build a `ClaudeClient` mock that always returns the given response text.
 */
function mockClient(response: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(
        ok({
          content: response,
          inputTokens: 500,
          outputTokens: 200,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        }),
      );
    },
  };
}

/**
 * Build a `ClaudeClient` mock that always returns an error.
 */
function failingClient(message: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(err(new Error(message)));
    },
  };
}

// ---------------------------------------------------------------------------
// Frontmatter fixtures
// ---------------------------------------------------------------------------

const VALID_CONCEPT_PAGE = `---
type: concept
id: 323e4567-e89b-12d3-a456-426614174002
title: Type Inference
definition: The ability of the compiler to deduce types automatically from context.
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: [typescript, types]
---
# Type Inference

Concept body mentioning [[another-concept]].
`;

/** Missing required `definition` field — causes a schema violation. */
const INVALID_CONCEPT_PAGE = `---
type: concept
id: 323e4567-e89b-12d3-a456-426614174099
title: Broken Concept
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: []
---
# Broken Concept

No definition field — this page is schema-invalid.
`;

const WIKI_CONCEPT_PAGE = `---
type: concept
id: 11111111-2222-3333-4444-555555555555
title: Self-Attention Mechanism
definition: A mechanism allowing each token to attend to all others.
source_ids: [aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]
source_path: raw/papers/attention.pdf
compiled_at: 2026-04-01T00:00:00.000Z
model: claude-sonnet-4-6
tags: [ml, attention]
---

## Summary

Self-attention allows each token to attend to all other tokens in the sequence.
It is the core building block of the Transformer architecture.
`;

// ---------------------------------------------------------------------------
// Per-test temp dir management
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-ask-int-'));
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: initialise a real ICO workspace via the CLI
// ---------------------------------------------------------------------------

/**
 * Run `ico init <name> --path <tmpBase>` and return the workspace root.
 * Asserts exit code 0 so callers can depend on the workspace existing.
 */
function cliInitWorkspace(name: string): string {
  const result = run(['init', name, '--path', tmpBase]);
  expect(result.exitCode, `init failed: ${result.stderr}`).toBe(0);
  return join(tmpBase, name);
}

// ---------------------------------------------------------------------------
// 1. Lint integration — subprocess tests
// ---------------------------------------------------------------------------

describe('ico lint — subprocess', { timeout: 30_000 }, () => {
  it('exits 0 and reports 0 issues on a clean empty workspace', () => {
    const wsRoot = cliInitWorkspace('ws');
    const result = run(['lint', '--workspace', wsRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0 pages valid');
    expect(result.stdout).toContain('All checks passed');
  });

  it('exits 1 and reports a schema violation for a malformed compiled page', () => {
    const wsRoot = cliInitWorkspace('ws');
    mkdirSync(join(wsRoot, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(wsRoot, 'wiki', 'concepts', 'broken.md'), INVALID_CONCEPT_PAGE, 'utf-8');

    const result = run(['lint', '--workspace', wsRoot]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('schema violation');
    expect(result.stdout).toContain('definition: Required');
  });

  it('--json exits 0 and emits valid JSON with the expected top-level structure', () => {
    const wsRoot = cliInitWorkspace('ws');
    mkdirSync(join(wsRoot, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(
      join(wsRoot, 'wiki', 'concepts', 'type-inference.md'),
      VALID_CONCEPT_PAGE,
      'utf-8',
    );

    // --json always exits 0 regardless of issue count (machine-readable path)
    const result = run(['lint', '--json', '--workspace', wsRoot]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('schema');
    expect(parsed).toHaveProperty('staleness');
    expect(parsed).toHaveProperty('uncompiled');
    expect(parsed).toHaveProperty('orphans');
    expect(parsed).toHaveProperty('issues');

    const schema = parsed['schema'] as Record<string, unknown>;
    expect(typeof schema['valid']).toBe('number');
    expect(typeof schema['invalid']).toBe('number');
    expect(Array.isArray(schema['errors'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Ask pipeline — direct function tests with a mocked client
// ---------------------------------------------------------------------------

// Shared per-describe state for ask pipeline tests
let wsPath: string;
let db: Database;

/**
 * Build a real workspace with the FTS5 index populated from WIKI_CONCEPT_PAGE.
 * Each ask-pipeline describe block calls this in beforeEach.
 */
function setupAskWorkspace(): void {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-ask-fn-'));

  // Write the compiled wiki page used by analyzeQuestion.
  mkdirSync(join(wsPath, 'wiki', 'concepts'), { recursive: true });
  writeFileSync(join(wsPath, 'wiki', 'concepts', 'self-attention.md'), WIKI_CONCEPT_PAGE, 'utf-8');

  // Open an in-memory database so tests never write to disk.
  const dbResult = initDatabase(':memory:');
  if (!dbResult.ok) throw new Error(dbResult.error.message);
  db = dbResult.value;

  const idxResult = createSearchIndex(db);
  if (!idxResult.ok) throw new Error(idxResult.error.message);

  const popResult = indexCompiledPages(db, wsPath);
  if (!popResult.ok) throw new Error(popResult.error.message);
}

function teardownAskWorkspace(): void {
  closeDatabase(db);
  rmSync(wsPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2a. Full pipeline: analyzeQuestion → relevant pages found
// ---------------------------------------------------------------------------

describe('ask pipeline — analyzeQuestion retrieves relevant pages', () => {
  beforeEach(setupAskWorkspace);
  afterEach(teardownAskWorkspace);

  it('finds relevant pages for a question whose terms appear in the wiki', () => {
    const result = analyzeQuestion(db, wsPath, 'What is self-attention?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    const titles = result.value.relevantPages.map((p) => p.title);
    expect(titles).toContain('Self-Attention Mechanism');
  });

  it('preserves the original question in the analysis', () => {
    const question = 'What is self-attention?';
    const result = analyzeQuestion(db, wsPath, question);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.originalQuestion).toBe(question);
  });
});

// ---------------------------------------------------------------------------
// 2b. generateAnswer — mocked client produces answer with citations
// ---------------------------------------------------------------------------

describe('ask pipeline — generateAnswer with mocked client', () => {
  const pages = [
    {
      path: 'concepts/self-attention.md',
      title: 'Self-Attention Mechanism',
      content: '## Summary\n\nSelf-attention allows each token to attend to all other tokens.',
    },
  ];

  it('returns an answer containing the mocked response text', async () => {
    const response = 'Self-attention is a mechanism. [source: Self-Attention Mechanism]';
    const result = await generateAnswer(mockClient(response), 'What is self-attention?', pages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answer).toBe(response);
  });

  it('returns citations parsed from the mocked response', async () => {
    const response = 'Self-attention enables parallelism. [source: Self-Attention Mechanism]';
    const result = await generateAnswer(
      mockClient(response),
      'How does self-attention work?',
      pages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations.length).toBeGreaterThan(0);
    expect(result.value.citations[0]?.pageTitle).toBe('Self-Attention Mechanism');
    expect(result.value.citations[0]?.pagePath).toBe('concepts/self-attention.md');
  });

  it('returns token counts from the mocked completion', async () => {
    const result = await generateAnswer(mockClient('Answer.'), 'Question?', pages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inputTokens).toBe(500);
    expect(result.value.outputTokens).toBe(200);
  });

  it('returns err when the mocked client fails', async () => {
    const result = await generateAnswer(
      failingClient('Rate limit exceeded'),
      'What is self-attention?',
      pages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Rate limit exceeded');
  });
});

// ---------------------------------------------------------------------------
// 2c. verifyCitations — citations verified against real wiki files
// ---------------------------------------------------------------------------

describe('ask pipeline — verifyCitations against real wiki files', () => {
  beforeEach(setupAskWorkspace);
  afterEach(teardownAskWorkspace);

  it('populates the verified list when the cited page file exists', () => {
    const citations = [
      {
        pageTitle: 'Self-Attention Mechanism',
        pagePath: 'concepts/self-attention.md',
        claim: 'Self-attention allows parallelism.',
      },
    ];

    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toHaveLength(1);
    expect(result.value.unverified).toHaveLength(0);
  });

  it('includes the raw-source provenance entry from frontmatter source_path', () => {
    const citations = [
      {
        pageTitle: 'Self-Attention Mechanism',
        pagePath: 'concepts/self-attention.md',
        claim: 'Self-attention is a core mechanism.',
      },
    ];

    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rawEntry = result.value.provenanceChain.find((e) => e.level === 'raw-source');
    expect(rawEntry).toBeDefined();
    expect(rawEntry?.path).toBe('raw/papers/attention.pdf');
  });
});

// ---------------------------------------------------------------------------
// 2d. Empty workspace ask — no relevant pages returned
// ---------------------------------------------------------------------------

describe('ask pipeline — empty workspace fallback', () => {
  let emptyWsPath: string;
  let emptyDb: Database;

  beforeEach(() => {
    emptyWsPath = mkdtempSync(join(tmpdir(), 'ico-ask-empty-'));
    mkdirSync(join(emptyWsPath, 'wiki'), { recursive: true });

    const dbResult = initDatabase(':memory:');
    if (!dbResult.ok) throw new Error(dbResult.error.message);
    emptyDb = dbResult.value;

    const idxResult = createSearchIndex(emptyDb);
    if (!idxResult.ok) throw new Error(idxResult.error.message);

    // Do NOT call indexCompiledPages — workspace has no compiled pages.
  });

  afterEach(() => {
    closeDatabase(emptyDb);
    rmSync(emptyWsPath, { recursive: true, force: true });
  });

  it('returns an empty relevantPages array when no wiki pages are indexed', () => {
    const result = analyzeQuestion(emptyDb, emptyWsPath, 'What is self-attention?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages).toHaveLength(0);
  });

  it('does not set suggestResearch for a simple question on an empty workspace', () => {
    const result = analyzeQuestion(emptyDb, emptyWsPath, 'What is self-attention?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestResearch).toBe(false);
  });
});
