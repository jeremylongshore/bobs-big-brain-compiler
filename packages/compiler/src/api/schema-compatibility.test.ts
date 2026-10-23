import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';

import { SourceSchema } from '@ico/types';

// No API call: validate the shared schema across the actual SDK Zod4 helper.
describe('shared schemas and SDK structured-output compatibility', () => {
  it('generates the SDK format and parses a valid source while stripping unknown fields', () => {
    const format = zodOutputFormat(SourceSchema);
    const source = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      path: 'raw/notes/source.md',
      type: 'markdown',
      title: null,
      author: null,
      ingested_at: '2026-10-23T00:00:00Z',
      word_count: 3,
      hash: 'fixture-hash',
      metadata: null,
    };
    expect(format.type).toBe('json_schema');
    expect(format.schema['type']).toBe('object');
    expect(format.parse(JSON.stringify({ ...source, extra: 'ignored' }))).toEqual(source);
    expect(() => format.parse(JSON.stringify({ ...source, word_count: -1 }))).toThrow(/word_count/);
  });
});
