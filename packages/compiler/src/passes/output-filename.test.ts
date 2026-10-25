import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { describe, expect, it } from 'vitest';

import { wikiOutputFilename } from './output-filename.js';

describe('logical wiki output filenames', () => {
  it('retains a readable stem and the full versioned identity digest', () => {
    const digest = createHash('sha256')
      .update(JSON.stringify(['ico-wiki-output-v1', 'summary', 'source-a']), 'utf8')
      .digest('hex');
    expect(wikiOutputFilename('summary', 'source-a', 'readme')).toBe(`readme--${digest}.md`);
  });

  it('separates same-basename sources even when their identities share a long prefix', () => {
    const first = wikiOutputFilename('summary', 'same-prefix-source-a', 'readme');
    const second = wikiOutputFilename('summary', 'same-prefix-source-b', 'readme');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^readme--[0-9a-f]{64}\.md$/);
    expect(second).toMatch(/^readme--[0-9a-f]{64}\.md$/);
  });

  it('separates page-kind namespaces without depending on a model response or body', () => {
    const concept = wikiOutputFilename('concept', 'shared-logical-id', 'shared');
    const entity = wikiOutputFilename('entity', 'shared-logical-id', 'shared');
    expect(concept).not.toBe(entity);
    expect(wikiOutputFilename('concept', 'shared-logical-id', 'shared')).toBe(concept);
  });

  it('bounds and confines filenames even with long or path-shaped display stems', () => {
    const name = wikiOutputFilename(
      'topic',
      '../identity/is/hashed',
      '../' + 'Label / '.repeat(100),
    );
    expect(basename(name)).toBe(name);
    expect(name.length).toBeLessThanOrEqual(133);
    expect(name).toMatch(/^[a-z0-9-]+--[0-9a-f]{64}\.md$/);
    expect(name).not.toContain('..');
  });

  it('keeps operator-only comparison keys readable without losing their identity', () => {
    const plus = wikiOutputFilename('concept', 'plus-id', '++');
    const hash = wikiOutputFilename('concept', 'hash-id', '#');
    expect(plus).toMatch(/^plus-plus--/);
    expect(hash).toMatch(/^hash--/);
    expect(plus).not.toBe(hash);
  });

  it('refuses absent identity or unreadable stem instead of assigning a shared fallback', () => {
    expect(() => wikiOutputFilename('summary', '  ', 'source')).toThrow('logical identity');
    expect(() => wikiOutputFilename('summary', 'source-id', '...')).toThrow('readable stem');
  });
});
