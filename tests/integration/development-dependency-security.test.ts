import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

// Resolve through the actual Stryker consumer, rather than a test-only qs copy.
const require = createRequire(import.meta.url);
const strykerRequire = createRequire(require.resolve('@stryker-mutator/core'));
const clientRequire = createRequire(strykerRequire.resolve('typed-rest-client'));
const qs = clientRequire('qs') as {
  parse(input: string, options: Record<string, unknown>): unknown;
  stringify(input: unknown): string;
};
const client = clientRequire('./Util.js') as {
  getUrl(
    resource: string,
    base: string,
    query: { params: unknown; options?: { arrayFormat: string } },
  ): string;
};

describe('Stryker query dependency security and compatibility', () => {
  it('retains repeated query values and encoded scalar values', () => {
    expect(
      client.getUrl('/results', 'https://fixture.invalid', {
        params: { tag: ['one', 'two'], name: 'a b' },
      }),
    ).toBe('https://fixture.invalid/results?tag=one&tag=two&name=a%20b');
  });

  it.each([null, undefined])('serializes nullable comma entries (%s)', (value) => {
    // GHSA-q8mj-m7cp-5q26, through the real client option translation.
    expect(
      client.getUrl('/results', 'https://fixture.invalid', {
        params: { tag: [value, 'two'] },
        options: { arrayFormat: 'comma' },
      }),
    ).toBe('https://fixture.invalid/results?tag=,two');
  });

  it('enforces the comma-array limit for bracketed keys', () => {
    // GHSA-x5fp-wj9c-mxmx: a four-element fixture suffices; no large allocation.
    expect(() =>
      qs.parse('tag[]=a,b,c,d', {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError);
  });

  it('round-trips an untrusted constructor key without calling it', () => {
    // GHSA-4mjr-xmp4-gh2g: preserve the key as data, not a callable method.
    const parsed = qs.parse('item[constructor][isBuffer]=value', { plainObjects: true });
    expect(qs.stringify(parsed)).toBe('item%5Bconstructor%5D%5BisBuffer%5D=value');
  });
});
