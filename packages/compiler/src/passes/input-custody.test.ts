import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Database,
  initDatabase,
  initWorkspace,
  readInputCustody,
  recordInputCustody,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { detectContradictions } from './contradict.js';
import { extractConcepts } from './extract.js';
import { identifyGaps } from './gap.js';
import { settleOutputCustody } from './input-custody.js';
import { addBacklinks } from './link.js';
import { summarizeSource } from './summarize.js';
import { synthesizeTopics } from './synthesize.js';

let db: Database;
let root: string;
const idA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const idB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function page(type: string, title: string, id = idA) {
  return `---\ntype: ${type}\nid: ${id}\ntitle: ${title}\ndefinition: A substantive synthetic definition.\nsummary: A synthetic overview of the supplied evidence.\nseverity: high\nquestion: Which evidence is missing?\npriority: high\nsource_id: ${id}\nsource_path: raw/a.md\ncontent_hash: ${hash('fixture')}\nsource_ids: []\nconcept_ids: []\nrelated_page_ids: []\ncompiled_at: 2026-11-22T00:00:00.000Z\nmodel: fixture\n---\n\nThis synthetic output has sufficient substantive text for deterministic validation and deliberately omits all advisory source references.\n`;
}
function client(...responses: string[]): ClaudeClient {
  let index = 0;
  return {
    createCompletion: vi.fn().mockImplementation(() =>
      Promise.resolve(
        ok({
          content: responses[Math.min(index++, responses.length - 1)]!,
          inputTokens: 20,
          outputTokens: 30,
          model: 'fixture',
          stopReason: 'end_turn',
        }),
      ),
    ),
  };
}
function seed(id: string, path: string, type = 'source-summary') {
  const bytes = `raw ${id}`;
  db.prepare(
    "INSERT INTO sources (id,path,type,ingested_at,hash) VALUES (?,?,'text','2026-11-22T00:00:00.000Z',?)",
  ).run(id, id, hash(bytes));
  const content = page(type, `Input ${id}`, id);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  const result = recordInputCustody(db, path, content, [
    { sourceId: id, contentHash: hash(bytes) },
  ]);
  if (!result.ok) throw result.error;
  return { bytes, content };
}
function closure(path: string) {
  return readInputCustody(db, path, readFileSync(join(root, path), 'utf8'));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ico-pass-custody-'));
  const workspace = initWorkspace('.', root);
  if (!workspace.ok) throw workspace.error;
  const opened = initDatabase(':memory:');
  if (!opened.ok) throw opened.error;
  db = opened.value;
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('actual compiler pass input custody', () => {
  it('summary binds actual source text and output bytes rather than a caller hash', async () => {
    const source = seed(idA, 'wiki/sources/seed.md');
    const result = await summarizeSource(
      client(page('source-summary', 'Summary')),
      db,
      root,
      idA,
      source.bytes,
      'raw/a.md',
      'caller-invented-hash',
    );
    if (!result.ok) throw result.error;
    expect(closure(result.value.outputPath)).toEqual({
      ok: true,
      value: [{ sourceId: idA, contentHash: hash(source.bytes) }],
    });
  });
  it('extract preserves omitted inputs and merges the actual contributing batches', async () => {
    seed(idA, 'wiki/sources/a.md');
    seed(idB, 'wiki/sources/b.md');
    const result = await extractConcepts(
      client(page('concept', 'Merged')),
      db,
      root,
      ['wiki/sources/a.md', 'wiki/sources/b.md'],
      { batchSize: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.pages).toHaveLength(1);
    const lineage = closure(result.value.pages[0]!.outputPath);
    expect(lineage.ok).toBe(true);
    if (lineage.ok) expect(lineage.value.map((x) => x.sourceId)).toEqual([idA, idB]);
    expect(db.prepare('SELECT * FROM compilation_sources').all()).toEqual([]);
  });
  it('synthesis includes shared concept context as well as summaries', async () => {
    seed(idA, 'wiki/sources/a.md');
    seed(idB, 'wiki/concepts/b.md', 'concept');
    const result = await synthesizeTopics(client(page('topic', 'Synthesis')), db, root);
    if (!result.ok) throw result.error;
    const lineage = closure(result.value.pages[0]!.outputPath);
    expect(lineage.ok).toBe(true);
    if (lineage.ok) expect(lineage.value.map((x) => x.sourceId)).toEqual([idA, idB]);
  });
  it('contradiction reduce includes every source represented in its digest', async () => {
    seed(idA, 'wiki/sources/a.md');
    seed(idB, 'wiki/sources/b.md');
    const result = await detectContradictions(
      client(
        'NO_CONTRADICTIONS_FOUND',
        'NO_CONTRADICTIONS_FOUND',
        page('contradiction', 'Cross batch'),
      ),
      db,
      root,
      { batchSize: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.pages).toHaveLength(1);
    const lineage = closure(result.value.pages[0]!.outputPath);
    expect(lineage.ok).toBe(true);
    if (lineage.ok) expect(lineage.value.map((x) => x.sourceId)).toEqual([idA, idB]);
  });
  it('gap analysis preserves all contributing page inputs despite empty references', async () => {
    seed(idA, 'wiki/sources/a.md');
    seed(idB, 'wiki/topics/b.md', 'topic');
    const result = await identifyGaps(client(page('open-question', 'Missing evidence')), db, root, {
      batchSize: 1,
    });
    if (!result.ok) throw result.error;
    expect(result.value.pages).toHaveLength(1);
    const lineage = closure(result.value.pages[0]!.outputPath);
    expect(lineage.ok).toBe(true);
    if (lineage.ok) expect(lineage.value.map((x) => x.sourceId)).toEqual([idA, idB]);
  });
  it('backlink rewrites preserve the page and referring-source custody', async () => {
    seed(idA, 'wiki/sources/a.md');
    seed(idB, 'wiki/concepts/b.md', 'concept');
    const path = 'wiki/concepts/b.md';
    const content = readFileSync(join(root, path), 'utf8') + '\nSee [[a]] for context.\n';
    writeFileSync(join(root, path), content);
    expect(
      recordInputCustody(db, path, content, [{ sourceId: idB, contentHash: hash(`raw ${idB}`) }])
        .ok,
    ).toBe(true);
    const result = await addBacklinks(client('unused'), db, root);
    if (!result.ok) throw result.error;
    expect(result.value.pagesUpdated).toBe(1);
    const lineage = closure('wiki/sources/a.md');
    expect(lineage.ok).toBe(true);
    if (lineage.ok) expect(lineage.value.map((x) => x.sourceId)).toEqual([idA, idB]);
  });
  it('legacy and altered input pages cannot inherit a previous same-byte receipt', async () => {
    seed(idA, 'wiki/sources/a.md');
    const first = await extractConcepts(client(page('concept', 'Repeated')), db, root, [
      'wiki/sources/a.md',
    ]);
    if (!first.ok) throw first.error;
    const output = first.value.pages[0]!.outputPath;
    expect(closure(output).ok).toBe(true);
    writeFileSync(join(root, 'wiki/sources/a.md'), 'changed source without custody');
    const second = await extractConcepts(client(page('concept', 'Repeated')), db, root, [
      'wiki/sources/a.md',
    ]);
    if (!second.ok) throw second.error;
    expect(closure(output).ok).toBe(false);
    const original = readFileSync(join(root, output), 'utf8');
    expect(
      recordInputCustody(db, output, original, [{ sourceId: idA, contentHash: hash(`raw ${idA}`) }])
        .ok,
    ).toBe(true);
    expect(settleOutputCustody(db, output, original, [null]).ok).toBe(true);
    expect(closure(output).ok).toBe(false);
  });
});
