import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, initDatabase, initWorkspace, scanForDisclosure } from '@ico/kernel';

import * as adapters from './adapters/registry.js';
import { runIngestPipeline } from './ingest-pipeline.js';

/** A real PDF with hex-encoded text: raw UTF-8 scanning cannot see its words. */
function hexTextPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td <${Buffer.from(text).toString('hex')}> Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /MediaBox [0 0 612 792] /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Include every file and directory, including SQLite, raw, trace and audit surfaces. */
function snapshot(root: string, prefix = ''): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      result.set(`${relative}/`, Buffer.alloc(0));
      for (const [name, bytes] of snapshot(root, relative)) result.set(name, bytes);
    } else result.set(relative, readFileSync(join(root, relative)));
  }
  return result;
}

function expectUnchanged(root: string, before: Map<string, Buffer>): void {
  const after = snapshot(root);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [name, bytes] of before) expect(after.get(name)?.equals(bytes), name).toBe(true);
}

describe('library ingestion disclosure boundary', () => {
  let base: string;
  let options: { workspacePath: string; dbPath: string };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'ico-disclosure-'));
    const workspace = initWorkspace('workspace', base);
    if (!workspace.ok) throw workspace.error;
    options = { workspacePath: workspace.value.root, dbPath: workspace.value.dbPath };
    const opened = initDatabase(options.dbPath);
    if (!opened.ok) throw opened.error;
    closeDatabase(opened.value);
    const seed = join(base, 'existing.md');
    writeFileSync(seed, '# Existing knowledge\n\nNeutral content.\n');
    const ingested = await runIngestPipeline(seed, options);
    if (!ingested.ok) throw ingested.error;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    ['sa!lary.md', '# Neutral title\n\nUseful facts', 'salary', false],
    ['salary.md', '# Neutral title\n\nUseful facts', 'salary', false],
    ['raw.md', '# Private\n\nsalary', 'salary', false],
    ['raw.txt', 'date of birth', 'date of birth', false],
    ['body.html', '<html><body><p>s&#97;lary</p></body></html>', 'salary', true],
    [
      'metadata.html',
      '<html><head><meta name="author" content="s&#97;lary"></head><body>Neutral body</body></html>',
      'salary',
      true,
    ],
    ['metadata.md', '---\ntitle: salary\n---\nNeutral body\n', 'salary', false],
    [
      'metadata-lines.html',
      '<meta name="author" content="50&#47;50&#10;split"><p>Neutral body</p>',
      '50/50\nsplit',
      true,
    ],
    ['extracted.pdf', hexTextPdf('salary'), 'salary', true],
  ] as const)(
    'refuses %s without persistent changes or matched text in the error',
    async (name, bytes, matched, encoded) => {
      const source = join(base, name);
      writeFileSync(source, bytes);
      if (encoded) {
        expect(scanForDisclosure(bytes.toString())).toBeNull();
        const parsed = await adapters.ingestSource(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw parsed.error;
        expect(
          scanForDisclosure(
            `${parsed.value.content}\n${Object.values(parsed.value.metadata).join('\n')}`,
          ),
        ).not.toBeNull();
      }
      const before = snapshot(options.workspacePath);
      const result = await runIngestPipeline(source, { ...options, force: true });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Prohibited fixture was accepted');
      expect(result.error.message).toMatch(/Disclosure check failed/);
      expect(result.error.message).not.toContain(matched);
      expect(result.error.cause).toBeUndefined();
      expectUnchanged(options.workspacePath, before);
    },
  );

  it('rejects raw prohibited bytes before adapter parsing', async () => {
    const source = join(base, 'unparseable.pdf');
    writeFileSync(source, 'salary');
    const parser = vi.spyOn(adapters, 'ingestSource');
    const before = snapshot(options.workspacePath);
    const result = await runIngestPipeline(source, options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Prohibited fixture was accepted');
    expect(result.error.message).toMatch(/Disclosure check failed/);
    expect(parser).not.toHaveBeenCalled();
    expectUnchanged(options.workspacePath, before);
  });

  it.each([
    ['clean.html', '<title>Neutral page</title><p>Useful facts</p>'],
    ['clean.pdf', hexTextPdf('Useful facts')],
  ] as const)('continues to persist clean %s', async (name, bytes) => {
    const source = join(base, name);
    writeFileSync(source, bytes);
    const result = await runIngestPipeline(source, options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(
      readFileSync(join(options.workspacePath, result.value.path)).equals(Buffer.from(bytes)),
    ).toBe(true);
  });
});
