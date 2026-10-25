import { describe, expect, it } from 'vitest';

import { contributingModelCalls, modelCallProvenance } from './trace-provenance.js';

const identity = { phase: 'map', batchIndex: 0, attempt: 0 } as const;

describe('model call provenance', () => {
  it('separates prompt boundaries, whitespace, Unicode spelling and lone surrogates', () => {
    const prompts = [
      ['ab', 'c'],
      ['a', 'bc'],
      ['ab', 'c '],
      ['ab', 'c\n'],
      ['ab', 'c\r\n'],
      ['ab', '\u00e9'],
      ['ab', 'e\u0301'],
      ['ab', '\ud800'],
      ['ab', '\ud801'],
      ['ab', '\ufffd'],
    ];
    const hashes = prompts.map(
      ([system, user]) =>
        modelCallProvenance(system!, user!, 'reported-model', identity).promptHash,
    );
    expect(new Set(hashes).size).toBe(prompts.length);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it('retains the client model separately from the exact-prompt commitment', () => {
    const first = modelCallProvenance('system', 'user', 'model-a', identity);
    const second = modelCallProvenance('system', 'user', 'model-b', {
      phase: 'reduce',
      attempt: 0,
    });
    expect(first.promptHash).toBe(second.promptHash);
    expect(first.responseModel).toBe('model-a');
    expect(second.responseModel).toBe('model-b');
    expect(second).not.toHaveProperty('batchIndex');
    expect(first).not.toHaveProperty('systemPrompt');
    expect(first).not.toHaveProperty('userPrompt');
  });

  it('deduplicates one call producing several pages while preserving distinct equal-prompt calls', () => {
    const first = modelCallProvenance('system', 'user', 'model-a', identity);
    const second = modelCallProvenance('system', 'user', 'model-a', { ...identity, batchIndex: 1 });
    expect(contributingModelCalls([0, 1, 2], [first, first, second])).toEqual([first, second]);
    expect(contributingModelCalls([2, 0], [first, first, second])).toEqual([second, first]);
    expect(contributingModelCalls([], [])).toEqual([]);
    expect(() => contributingModelCalls([1], [first])).toThrow('Missing raw-page');
  });
});
