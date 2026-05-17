/**
 * Synthetic compiled-wiki generator for the benchmark suite (E10-B06).
 *
 * Counterpart to {@link generateCorpus}: produces validly-shaped
 * `concept` and `topic` pages directly under `wiki/concepts/` and
 * `wiki/topics/` so scenarios like `lint` and `render` have realistic
 * compiled state to operate on WITHOUT having to run the (Claude-
 * dependent) compile pipeline first.
 *
 * The frontmatter conforms to ConceptFrontmatterSchema and
 * TopicFrontmatterSchema from `@ico/types` — same validators
 * `runLint` invokes via `validateCompiledPage`. If the schemas change,
 * this generator must change with them or every lint-scenario run will
 * report 100% schema-invalid pages and skew timings.
 *
 * Deterministic: same seed + same counts = byte-identical output.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Local deterministic UUIDv4 generator
// ---------------------------------------------------------------------------
//
// Cannot use `node:crypto.randomUUID()` here — its non-determinism would
// undermine the deterministic-corpus contract. Derive UUIDs from the
// seeded PRNG so two runs with the same seed yield identical IDs (and
// therefore identical hashed content + identical file bytes).
//

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
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Render a deterministic UUIDv4-shaped string from the PRNG. */
function rngUuid(rng: () => number): string {
  const hex = (n: number, len: number): string =>
    Math.floor(rng() * 16 ** n)
      .toString(16)
      .padStart(len, '0');
  // 8-4-4-4-12 layout. Fixed version (4) and variant (8) nibbles per RFC 4122.
  const part1 = hex(8, 8);
  const part2 = hex(4, 4);
  const part3 = `4${hex(3, 3)}`;
  const part4Hi = (8 + Math.floor(rng() * 4)).toString(16); // 8,9,a,b
  const part4 = `${part4Hi}${hex(3, 3)}`;
  const part5 = `${hex(6, 6)}${hex(6, 6)}`;
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

// ---------------------------------------------------------------------------
// Word banks (kept independent from corpus.ts so changes there don't
// silently shift wiki-page hashes here)
// ---------------------------------------------------------------------------

const CONCEPT_NOUNS = [
  'Attention',
  'Embedding',
  'Tokenization',
  'Gradient',
  'Optimizer',
  'Regularizer',
  'Convolution',
  'Recurrence',
  'Inference',
  'Caching',
] as const;

const CONCEPT_QUALIFIERS = [
  'Mechanism',
  'Layer',
  'Strategy',
  'Heuristic',
  'Pattern',
  'Primitive',
  'Invariant',
  'Contract',
] as const;

const TOPIC_TITLES = [
  'Transformers',
  'Distributed Inference',
  'Memory Locality',
  'Throughput Scaling',
  'Tail Latency',
  'Cache Coherence',
  'Consensus Protocols',
] as const;

const TAGS = ['ml', 'systems', 'distributed', 'performance', 'reliability'] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateWikiOptions {
  /** Absolute path to the workspace root. `wiki/concepts/` and `wiki/topics/` are written into. */
  workspacePath: string;
  /** Number of concept pages to write. Must be >= 0. */
  conceptCount: number;
  /** Number of topic pages to write. Must be >= 0. */
  topicCount: number;
  /** Approximate body word count per page. Default 300. */
  bodyWords?: number;
  /** PRNG seed. Same seed + counts + body-words = byte-identical output. */
  seed?: number;
  /** Model name recorded in `model:` frontmatter. Default 'bench-stub'. */
  model?: string;
}

export interface GenerateWikiResult {
  /** Absolute paths of concept pages written. */
  conceptPaths: string[];
  /** Absolute paths of topic pages written. */
  topicPaths: string[];
  /** UUIDs assigned to the generated concepts (for cross-referencing in topics). */
  conceptIds: string[];
  /** UUIDs assigned to the generated topics. */
  topicIds: string[];
}

/**
 * Generate `conceptCount` concept pages and `topicCount` topic pages.
 * Topics reference up to 3 concept IDs as `source_ids` so the lint
 * orphan-detector finds the realistic mix (some orphans, some linked).
 */
export function generateWiki(options: GenerateWikiOptions): GenerateWikiResult {
  if (options.conceptCount < 0) {
    throw new Error(`conceptCount must be >= 0, got ${options.conceptCount}`);
  }
  if (options.topicCount < 0) {
    throw new Error(`topicCount must be >= 0, got ${options.topicCount}`);
  }
  const bodyWords = options.bodyWords ?? 300;
  const seed = options.seed ?? 0xdeed;
  const model = options.model ?? 'bench-stub';
  const rng = makeRng(seed);

  const conceptsDir = resolve(options.workspacePath, 'wiki', 'concepts');
  const topicsDir = resolve(options.workspacePath, 'wiki', 'topics');
  mkdirSync(conceptsDir, { recursive: true });
  mkdirSync(topicsDir, { recursive: true });

  // Stable compile time so two runs with the same seed produce identical
  // files. Wall-clock here would re-introduce non-determinism.
  const compiledAt = '2026-01-01T00:00:00.000Z';

  const conceptIds: string[] = [];
  const conceptPaths: string[] = [];
  for (let i = 0; i < options.conceptCount; i += 1) {
    const id = rngUuid(rng);
    conceptIds.push(id);
    const noun = pick(rng, CONCEPT_NOUNS);
    const qualifier = pick(rng, CONCEPT_QUALIFIERS);
    const title = `${noun} ${qualifier} ${i}`;
    const slug = `${noun.toLowerCase()}-${qualifier.toLowerCase()}-${i}`;
    const body = renderBody(rng, bodyWords);
    const sourceId = rngUuid(rng); // Synthetic source UUID — uuid-shaped, never resolved.
    const tagCount = 1 + Math.floor(rng() * 2);
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t += 1) tags.push(pick(rng, TAGS));

    // No quotes around values — the validator's hand-rolled YAML parser
    // (packages/compiler/src/validation.ts) does NOT strip quotes, so a
    // quoted `compiled_at: "2026-01-01T..."` would include literal quote
    // characters in the string and fail Zod's datetime check.
    const content = [
      '---',
      `type: concept`,
      `id: ${id}`,
      `title: ${title}`,
      `definition: ${title} is a placeholder definition for benchmark fixtures.`,
      `source_ids:`,
      `  - ${sourceId}`,
      `compiled_at: ${compiledAt}`,
      `model: ${model}`,
      `tags: [${tags.join(', ')}]`,
      '---',
      '',
      `# ${title}`,
      '',
      body,
      '',
    ].join('\n');

    const path = resolve(conceptsDir, `${slug}.md`);
    writeFileSync(path, content, 'utf-8');
    conceptPaths.push(path);
  }

  const topicIds: string[] = [];
  const topicPaths: string[] = [];
  for (let i = 0; i < options.topicCount; i += 1) {
    const id = rngUuid(rng);
    topicIds.push(id);
    const title = `${pick(rng, TOPIC_TITLES)} ${i}`;
    const slug = `topic-${i}`;
    const body = renderBody(rng, bodyWords);
    // Reference up to 3 concept IDs (or empty when no concepts exist).
    // Cross-references give the orphan check something realistic to walk.
    const refCount = Math.min(conceptIds.length, 3);
    const refs: string[] = [];
    for (let r = 0; r < refCount; r += 1) {
      const idx = Math.floor(rng() * conceptIds.length);
      refs.push(conceptIds[idx]!);
    }
    const sourceId = rngUuid(rng);

    const content = [
      '---',
      `type: topic`,
      `id: ${id}`,
      `title: ${title}`,
      `source_ids:`,
      `  - ${sourceId}`,
      ...refs.map((r) => `  - ${r}`),
      `compiled_at: ${compiledAt}`,
      `model: ${model}`,
      '---',
      '',
      `# ${title}`,
      '',
      body,
      '',
      // Reference at least one concept by slug so the orphan check
      // catches links — keeps the lint scenario representative. Use
      // path.basename for cross-platform slug extraction; the absolute
      // path uses the host separator (`\` on Windows, `/` on POSIX).
      ...(conceptPaths.length > 0
        ? [`See also: [[${basename(conceptPaths[i % conceptPaths.length]!, '.md')}]]`]
        : []),
      '',
    ].join('\n');

    const path = resolve(topicsDir, `${slug}.md`);
    writeFileSync(path, content, 'utf-8');
    topicPaths.push(path);
  }

  return { conceptPaths, topicPaths, conceptIds, topicIds };
}

// ---------------------------------------------------------------------------
// Body rendering — small word bank to keep diffs reviewable, large
// enough to defeat naive dedup.
// ---------------------------------------------------------------------------

const BODY_WORDS = [
  'attention',
  'gradient',
  'embedding',
  'token',
  'pipeline',
  'cache',
  'index',
  'shard',
  'replica',
  'latency',
  'throughput',
  'memory',
  'budget',
  'workload',
  'tail',
  'fanout',
  'queue',
  'partition',
  'offset',
  'snapshot',
  'epoch',
  'segment',
  'page',
  'lock',
  'fence',
] as const;

function renderBody(rng: () => number, wordCount: number): string {
  const wordsPerParagraph = 80;
  const paragraphs = Math.max(1, Math.ceil(wordCount / wordsPerParagraph));
  const lines: string[] = [];
  let remaining = wordCount;
  for (let p = 0; p < paragraphs; p += 1) {
    const take = Math.min(wordsPerParagraph, remaining);
    if (take <= 0) break;
    const words: string[] = [];
    for (let w = 0; w < take; w += 1) words.push(pick(rng, BODY_WORDS));
    const first = words[0]!;
    words[0] = first.charAt(0).toUpperCase() + first.slice(1);
    lines.push(`${words.join(' ')}.`);
    remaining -= take;
  }
  return lines.join('\n');
}
