import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Exercise the exact dependency entrypoint used by our public schemas. A package
// version check alone would miss accidentally importing the still-unfixed v3 API.
describe('bounded collection validation', () => {
  it('rejects an oversized array before visiting elements, including async parsing', async () => {
    let visited = 0;
    const element = z.string().refine(() => {
      visited++;
      return true;
    });
    const schema = z.object({ values: z.array(element).max(2) });
    const oversized = { values: Array.from({ length: 64 }, () => 'valid') };
    for (const result of [schema.safeParse(oversized), await schema.safeParseAsync(oversized)]) {
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toMatchObject([{ code: 'too_big', path: ['values'] }]);
      if (!result.success) expect(result.error.issues).toHaveLength(1);
    }
    expect(visited).toBe(0);
    expect(schema.parse({ values: ['a', 'b'] })).toEqual({ values: ['a', 'b'] });
    expect(visited).toBe(2);
  });

  it('rejects an oversized set before visiting elements', () => {
    let visited = 0;
    const schema = z
      .set(
        z.string().refine(() => {
          visited++;
          return true;
        }),
      )
      .max(2);
    const result = schema.safeParse(new Set(['a', 'b', 'c']));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big' }]);
    expect(visited).toBe(0);
    expect(schema.parse(new Set(['a', 'b']))).toEqual(new Set(['a', 'b']));
    expect(visited).toBe(2);
  });

  it('rejects an oversized map before visiting either keys or values', () => {
    let visited = 0;
    const element = z.string().refine(() => {
      visited++;
      return true;
    });
    const schema = z.map(element, element).max(2);
    const result = schema.safeParse(
      new Map([
        ['a', 'one'],
        ['b', 'two'],
        ['c', 'three'],
      ]),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big' }]);
    expect(visited).toBe(0);
    expect(schema.parse(new Map([['a', 'one']]))).toEqual(new Map([['a', 'one']]));
    expect(visited).toBe(2);
  });
});
