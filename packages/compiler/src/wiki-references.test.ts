import { describe, expect, it } from 'vitest';

import { wikiReferenceResolver, wikiReferences } from './wiki-references.js';

describe('wiki reference identity', () => {
  it('ignores frontmatter and labels while preserving operators', () => {
    expect([
      ...wikiReferences('---\ntitle: [[ignored]]\n---\n[[C++|C plus plus]] [[C#]] [[C]]'),
    ]).toEqual(['C++', 'C#', 'C']);
  });
  it('keeps ordinary punctuation/case aliases and refuses duplicate exact stems', () => {
    const first = {
      slug: 'identity-a',
      content: '---\ntitle: "Knowledge Compilation!"\n---\nBody',
    };
    const second = { slug: 'identity-a', content: '---\ntitle: Elsewhere\n---\nBody' };
    const resolve = wikiReferenceResolver([first, second]);
    expect(resolve('knowledge compilation')).toBe(first);
    expect(resolve('identity-a')).toBeUndefined();
  });
  it('does not use a body title as an alias', () => {
    expect(
      wikiReferenceResolver([{ slug: 'some-file', content: 'Body\ntitle: Pretend' }])('Pretend'),
    ).toBeUndefined();
  });
});
