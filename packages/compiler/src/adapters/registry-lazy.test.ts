import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfLoader = vi.hoisted(() => vi.fn());
vi.mock('pdf-parse', () => {
  pdfLoader();
  throw new Error('PDF dependency loader deliberately unavailable');
});

let directory: string;
beforeEach(async () => {
  vi.resetModules();
  pdfLoader.mockClear();
  directory = await mkdtemp(join(tmpdir(), 'ico-lazy-pdf-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('PDF dependency isolation at the compiler entry point', () => {
  it('imports the compiler and ingests non-PDF formats without loading a broken PDF dependency', async () => {
    const { ingestSource, detectSourceType } = await import('../index.js');
    expect(detectSourceType('report.pdf')).toBe('pdf');
    expect(pdfLoader).not.toHaveBeenCalled();
    for (const [name, body, expectedType] of [
      ['notes.md', '# Notes\n\nA current markdown source.', 'markdown'],
      ['notes.txt', 'A current plain text source.', 'markdown'],
      ['clip.html', '<html><body><p>A current web clip.</p></body></html>', 'html'],
    ] as const) {
      const path = join(directory, name);
      await writeFile(path, body);
      const result = await ingestSource(path);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.sourceType).toBe(expectedType);
    }
    const overridden = join(directory, 'markdown-disguised.pdf');
    await writeFile(overridden, '# Explicit markdown override');
    expect((await ingestSource(overridden, 'markdown')).ok).toBe(true);
    expect(pdfLoader).not.toHaveBeenCalled();
  });

  it('returns a Result error when the PDF dependency fails to load', async () => {
    const { ingestSource } = await import('../index.js');
    const result = await ingestSource(join(directory, 'report.pdf'));
    expect(pdfLoader).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});
