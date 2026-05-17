/**
 * Synthetic corpus generator for the benchmark suite (E10-B06).
 *
 * Produces N markdown source files with realistic frontmatter + body so
 * the ingest / compile / lint code paths exercise their full behaviour
 * (frontmatter parsing, content hashing, full-text indexing) instead of
 * trivial fixture content.
 *
 * Determinism is enforced via a seeded PRNG: same seed + same count
 * always produces byte-identical files. This keeps benchmark runs
 * reproducible across machines and over time so before/after
 * comparisons are meaningful.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Small, fast, good enough for fixture variation.
// ---------------------------------------------------------------------------

/**
 * Mulberry32 PRNG. Returns a function that yields uniform [0, 1) floats.
 * Reference: https://stackoverflow.com/a/47593316 (public domain).
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  // arr.length is checked by callers; this never receives an empty array.
  return arr[Math.floor(rng() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// Word banks. Small enough to keep diffs reviewable; large enough that
// 500-source corpora don't degenerate into identical bodies (which would
// short-circuit dedup-by-hash and hide real performance characteristics).
// ---------------------------------------------------------------------------

const TITLE_NOUNS = [
  'Attention',
  'Embeddings',
  'Transformers',
  'Tokenization',
  'Gradients',
  'Optimization',
  'Regularization',
  'Convolution',
  'Recurrence',
  'Inference',
  'Training',
  'Evaluation',
  'Latency',
  'Throughput',
  'Memory',
  'Caching',
  'Sharding',
  'Replication',
  'Consensus',
  'Provenance',
] as const;

const TITLE_QUALIFIERS = [
  'Scaling Laws',
  'Edge Cases',
  'Failure Modes',
  'Empirical Study',
  'Field Notes',
  'Operator Guide',
  'Reference',
  'Survey',
  'Postmortem',
  'Design Notes',
] as const;

const TAGS = [
  'ml',
  'systems',
  'distributed',
  'storage',
  'inference',
  'evaluation',
  'observability',
  'reliability',
  'performance',
  'security',
] as const;

const BODY_WORDS = [
  'attention',
  'gradient',
  'transformer',
  'embedding',
  'token',
  'context',
  'pipeline',
  'cache',
  'index',
  'shard',
  'replica',
  'quorum',
  'latency',
  'throughput',
  'memory',
  'budget',
  'workload',
  'tail',
  'percentile',
  'fanout',
  'queue',
  'consumer',
  'producer',
  'partition',
  'offset',
  'commit',
  'rollback',
  'snapshot',
  'compaction',
  'tombstone',
  'leader',
  'follower',
  'epoch',
  'term',
  'log',
  'segment',
  'page',
  'block',
  'frame',
  'arena',
  'scheduler',
  'preempt',
  'yield',
  'fence',
  'barrier',
  'lock',
  'mutex',
  'rcu',
  'atomic',
  'acquire',
  'release',
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateCorpusOptions {
  /** Absolute path to the directory where source files will be written. */
  outputDir: string;
  /** Number of source files to generate. Must be ≥ 1. */
  sourceCount: number;
  /** Approximate body word count per file. Defaults to 500. */
  bodyWords?: number;
  /** PRNG seed. Same seed + same count + same bodyWords = byte-identical output. */
  seed?: number;
}

export interface GenerateCorpusResult {
  /** Absolute paths of every file written, in generation order. */
  files: string[];
  /** Sum of bytes written across all files (excluding directory overhead). */
  totalBytes: number;
}

/**
 * Generate a synthetic markdown corpus into `outputDir`. The directory
 * is created if it does not exist. Existing files in the directory are
 * NOT cleaned — the caller owns the lifecycle of the output dir.
 *
 * Each file is named `source-NNNN.md` (zero-padded to four digits for
 * predictable lexical ordering up to 9999 sources). Frontmatter
 * includes title, type, tags, and a synthetic creation date.
 */
export function generateCorpus(options: GenerateCorpusOptions): GenerateCorpusResult {
  if (options.sourceCount < 1) {
    throw new Error(`sourceCount must be >= 1, got ${options.sourceCount}`);
  }
  const bodyWords = options.bodyWords ?? 500;
  const seed = options.seed ?? 0xc0ffee;
  const rng = makeRng(seed);

  mkdirSync(options.outputDir, { recursive: true });

  const files: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < options.sourceCount; i += 1) {
    const filename = `source-${String(i).padStart(4, '0')}.md`;
    const absPath = resolve(options.outputDir, filename);
    const content = renderSource({ index: i, bodyWords, rng });
    writeFileSync(absPath, content, 'utf-8');
    files.push(absPath);
    totalBytes += Buffer.byteLength(content, 'utf-8');
  }

  return { files, totalBytes };
}

// ---------------------------------------------------------------------------
// Per-source rendering
// ---------------------------------------------------------------------------

interface RenderSourceArgs {
  index: number;
  bodyWords: number;
  rng: () => number;
}

function renderSource(args: RenderSourceArgs): string {
  const { index, bodyWords, rng } = args;
  const noun = pick(rng, TITLE_NOUNS);
  const qualifier = pick(rng, TITLE_QUALIFIERS);
  // Title includes the index so titles stay unique across the corpus —
  // duplicate titles would collapse the wiki index in a way that hides
  // real lookup cost.
  const title = `${noun} ${qualifier} #${index}`;

  const tagCount = 1 + Math.floor(rng() * 3); // 1–3 tags
  const tags = new Set<string>();
  while (tags.size < tagCount) {
    tags.add(pick(rng, TAGS));
  }

  // Stable synthetic date — keeps frontmatter parseable but not Date.now-
  // dependent.
  const day = 1 + (index % 28);
  const month = 1 + ((index / 28) | 0) % 12;
  const created = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const body = renderBody(rng, bodyWords);

  // Title is quoted because the `#N` suffix that uniqueness depends on
  // would otherwise be parsed as a YAML comment, stripping it.
  return [
    '---',
    `title: "${title}"`,
    'type: source',
    `created: "${created}"`,
    `tags: [${[...tags].join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderBody(rng: () => number, wordCount: number): string {
  // Roughly one paragraph per ~80 words, plus a heading every ~3 paragraphs
  // so the markdown structure is non-trivial.
  const wordsPerParagraph = 80;
  const paragraphs = Math.max(1, Math.ceil(wordCount / wordsPerParagraph));
  const lines: string[] = [];
  let wordsRemaining = wordCount;

  for (let p = 0; p < paragraphs; p += 1) {
    if (p > 0 && p % 3 === 0) {
      lines.push('');
      lines.push(`## ${pick(rng, TITLE_NOUNS)} Section ${p / 3}`);
      lines.push('');
    }
    const take = Math.min(wordsPerParagraph, wordsRemaining);
    if (take <= 0) break;
    const words: string[] = [];
    for (let w = 0; w < take; w += 1) {
      words.push(pick(rng, BODY_WORDS));
    }
    // Capitalise first word, terminate the paragraph.
    const first = words[0]!;
    words[0] = first.charAt(0).toUpperCase() + first.slice(1);
    lines.push(`${words.join(' ')}.`);
    wordsRemaining -= take;
  }

  return lines.join('\n');
}
