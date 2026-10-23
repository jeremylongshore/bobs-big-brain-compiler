import { describe, expect, it, vi } from 'vitest';

import { err } from '@ico/types';

const adapter = vi.hoisted(() => vi.fn());
vi.mock('./pdf.js', () => ({ ingestPdf: adapter }));
import { ingestSource } from './registry.js';

describe('PDF registry failure boundary', () => {
  it.each([new Error('adapter failed before its own catch'), 'non-Error adapter failure'])(
    'returns a Result error when the adapter rejects (%s)',
    async (cause) => {
      adapter.mockRejectedValueOnce(cause);
      const result = await ingestSource('fixture.pdf');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        if (cause instanceof Error) expect(result.error).toBe(cause);
        else expect(result.error.message).toBe(cause);
      }
    },
  );

  it('preserves an adapter-returned Result error unchanged', async () => {
    const failure = err(new Error('PDF format rejected'));
    adapter.mockResolvedValueOnce(failure);
    expect(await ingestSource('fixture.txt', 'pdf')).toBe(failure);
    expect(adapter).toHaveBeenLastCalledWith('fixture.txt');
  });
});
