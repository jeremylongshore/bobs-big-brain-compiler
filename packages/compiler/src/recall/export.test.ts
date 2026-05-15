/**
 * Tests for the Anki recall export (E9-B11).
 *
 * Real workspace, real card files on disk. No DB needed — exporter is
 * pure-filesystem.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initWorkspace } from '@ico/kernel';

import { exportRecallAnki } from './export.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Env {
  base: string;
  wsRoot: string;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-export-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  env = { base, wsRoot: ws.value.root };
});
afterEach(() => {
  rmSync(env.base, { recursive: true, force: true });
});

interface CardSpec {
  filename: string;
  concept: string;
  topic: string;
  question: string;
  answer: string;
  sources?: string[];
  type?: string;
}

function writeCard(spec: CardSpec): void {
  const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const sources =
    spec.sources && spec.sources.length > 0
      ? `source_pages:\n${spec.sources.map((s) => `  - ${s}`).join('\n')}`
      : 'source_pages: []';
  const fm = [
    '---',
    `type: ${spec.type ?? 'recall-card'}`,
    `topic: ${JSON.stringify(spec.topic)}`,
    `concept: ${JSON.stringify(spec.concept)}`,
    'generated_at: 2026-04-08T12:00:00.000Z',
    'model: claude-sonnet-4-6',
    'input_tokens: 100',
    'output_tokens: 50',
    'tokens_used: 150',
    sources,
    '---',
    '',
  ].join('\n');
  const body = [
    `# ${spec.concept}`,
    '',
    '## Question',
    '',
    spec.question,
    '',
    '## Answer',
    '',
    spec.answer,
    '',
  ].join('\n');
  writeFileSync(join(cardsDir, spec.filename), `${fm}${body}`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('exportRecallAnki — happy path', () => {
  it('produces one TSV row per card with three tab-separated columns', () => {
    writeCard({
      filename: 'self-attention.md',
      concept: 'Self-Attention',
      topic: 'transformer attention',
      question: 'What does self-attention compute?',
      answer: 'A weighted sum over all input positions.',
      sources: ['concepts/self-attention.md'],
    });
    writeCard({
      filename: 'quadratic-scaling.md',
      concept: 'Quadratic Scaling',
      topic: 'transformer attention',
      question: 'How does attention scale?',
      answer: 'Quadratically — O(n²).',
      sources: ['topics/transformer-attention.md'],
    });

    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cards).toHaveLength(2);
    expect(r.value.outPath).toBeNull();

    const lines = r.value.tsv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const cols = line.split('\t');
      expect(cols).toHaveLength(3);
    }
  });

  it('encodes topic + source-page tags in the third column', () => {
    writeCard({
      filename: 'c.md',
      concept: 'C',
      topic: 'Transformer Attention',
      question: 'q',
      answer: 'a',
      sources: ['concepts/self-attention.md', 'topics/transformer-attention.md'],
    });

    const r = exportRecallAnki(env.wsRoot);
    if (!r.ok) throw r.error;
    const tags = r.value.cards[0]!.tags;
    expect(tags).toContain('topic:transformer-attention');
    expect(tags).toContain('source:concepts-self-attention');
    expect(tags).toContain('source:topics-transformer-attention');
  });

  it('escapes newlines and tabs inside question / answer fields', () => {
    writeCard({
      filename: 'c.md',
      concept: 'C',
      topic: 't',
      question: 'Line one\nLine two\twith tab',
      answer: 'Answer\nover\nthree lines',
    });

    const r = exportRecallAnki(env.wsRoot);
    if (!r.ok) throw r.error;
    const cols = r.value.tsv.split('\n')[0]!.split('\t');
    expect(cols).toHaveLength(3);
    const [front, back] = cols;
    expect(front).toContain('<br>');
    expect(front).not.toMatch(/\n/);
    expect(back).toContain('<br>');
    expect(back).not.toMatch(/\n/);
    // Tab in question was replaced with 4 spaces.
    expect(front).toContain('    with tab');
  });

  it('filters by topic when options.topic is provided', () => {
    writeCard({
      filename: 'a.md',
      concept: 'A',
      topic: 'attention',
      question: 'qa',
      answer: 'aa',
    });
    writeCard({
      filename: 'b.md',
      concept: 'B',
      topic: 'embeddings',
      question: 'qb',
      answer: 'ab',
    });

    const r = exportRecallAnki(env.wsRoot, { topic: 'attention' });
    if (!r.ok) throw r.error;
    expect(r.value.cards).toHaveLength(1);
    expect(r.value.cards[0]!.topic).toBe('attention');
  });

  it('writes the TSV to disk atomically when outPath is provided', () => {
    writeCard({
      filename: 'a.md',
      concept: 'A',
      topic: 't',
      question: 'q',
      answer: 'a',
    });
    const outRel = join('recall', 'exports', 'all-anki.txt');
    const r = exportRecallAnki(env.wsRoot, { outPath: outRel });
    if (!r.ok) throw r.error;
    expect(r.value.outPath).toBe(outRel);

    const outAbs = resolve(env.wsRoot, outRel);
    expect(existsSync(outAbs)).toBe(true);
    const written = readFileSync(outAbs, 'utf-8');
    expect(written).toBe(r.value.tsv);
    // No leftover .tmp file
    expect(existsSync(`${outAbs}.tmp`)).toBe(false);
  });

  it('skips non-recall-card files in the cards directory', () => {
    writeCard({ filename: 'real.md', concept: 'X', topic: 't', question: 'q', answer: 'a' });
    writeCard({
      filename: 'fake.md',
      concept: 'Y',
      topic: 't',
      question: 'q',
      answer: 'a',
      type: 'something-else',
    });
    const r = exportRecallAnki(env.wsRoot);
    if (!r.ok) throw r.error;
    expect(r.value.cards).toHaveLength(1);
    expect(r.value.cards[0]!.concept).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('exportRecallAnki — error paths', () => {
  it('returns err when the cards directory is missing', () => {
    // initWorkspace creates `recall/cards/` — remove it to exercise the
    // not-found path.
    rmSync(resolve(env.wsRoot, 'recall', 'cards'), { recursive: true, force: true });
    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Cards directory not found');
  });

  it('returns err when the cards directory is empty', () => {
    // initWorkspace already created the dir empty; no setup needed.
    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('No card files');
  });

  it('returns err when topic filter excludes everything', () => {
    writeCard({ filename: 'a.md', concept: 'A', topic: 'attention', question: 'q', answer: 'a' });
    const r = exportRecallAnki(env.wsRoot, { topic: 'embeddings' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Zero cards exported');
  });

  it('returns err when a card is missing Q/A sections', () => {
    const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(
      join(cardsDir, 'broken.md'),
      ['---', 'type: recall-card', 'topic: "t"', 'concept: "c"', 'source_pages: []', '---', '', 'No headings here.', ''].join('\n'),
      'utf-8',
    );
    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Question or Answer');
  });

  it('returns err when a card has no frontmatter at all', () => {
    const cardsDir = resolve(env.wsRoot, 'recall', 'cards');
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, 'nofm.md'), '# Just a heading\n\nbody\n', 'utf-8');
    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('frontmatter');
  });

  it('rejects --out paths that escape the workspace via ..', () => {
    writeCard({ filename: 'a.md', concept: 'A', topic: 't', question: 'q', answer: 'a' });
    const r = exportRecallAnki(env.wsRoot, { outPath: '../escape.txt' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('inside the workspace');
  });

  it('rejects absolute --out paths outside the workspace', () => {
    writeCard({ filename: 'a.md', concept: 'A', topic: 't', question: 'q', answer: 'a' });
    const r = exportRecallAnki(env.wsRoot, { outPath: '/tmp/foo.txt' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('inside the workspace');
  });

  it('ignores subdirectories that happen to end in .md', () => {
    writeCard({ filename: 'real.md', concept: 'R', topic: 't', question: 'q', answer: 'a' });
    // Create a subdirectory whose name ends in .md — readdir-with-filetypes
    // should skip it without throwing EISDIR.
    mkdirSync(resolve(env.wsRoot, 'recall', 'cards', 'archive.md'), { recursive: true });
    const r = exportRecallAnki(env.wsRoot);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cards).toHaveLength(1);
  });
});
