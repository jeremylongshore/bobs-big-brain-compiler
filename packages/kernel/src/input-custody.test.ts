import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CustodyRoot,
  invalidateInputCustody,
  readInputCustody,
  recordInputCustody,
  sourceInputCustody,
} from './input-custody.js';
import { type Database, initDatabase } from './state.js';

let db: Database;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const roots = [
  { sourceId: 'public', contentHash: hash('public material') },
  { sourceId: 'restricted', contentHash: hash('restricted material') },
];
beforeEach(() => {
  const opened = initDatabase(':memory:');
  if (!opened.ok) throw opened.error;
  db = opened.value;
  for (const root of roots)
    db.prepare(
      `INSERT INTO sources
    (id,path,type,ingested_at,hash) VALUES (?,?,'text','2026-11-22T00:00:00.000Z',?)`,
    ).run(root.sourceId, root.sourceId, root.contentHash);
});
afterEach(() => db.close());

describe('complete input custody storage', () => {
  it('canonicalizes reordered and repeated inputs into the same versioned record', () => {
    expect(recordInputCustody(db, 'wiki/a.md', 'output', roots).ok).toBe(true);
    const first = db.prepare('SELECT * FROM compilation_input_custody').get();
    expect(
      recordInputCustody(db, 'wiki/a.md', 'output', [roots[1]!, roots[0]!, roots[1]!]).ok,
    ).toBe(true);
    expect(db.prepare('SELECT * FROM compilation_input_custody').get()).toEqual(first);
    expect((first as { roots_json: string }).roots_json).toBe(JSON.stringify(roots));
    const expected = createHash('sha256')
      .update(JSON.stringify(['ico-input-custody-v1', 'wiki/a.md', hash('output'), roots]))
      .digest('hex');
    expect((first as { record_hash: string }).record_hash).toBe(expected);
  });
  it('invalidates only the selected output even when its bytes are unchanged', () => {
    expect(recordInputCustody(db, 'wiki/a.md', 'same bytes', roots).ok).toBe(true);
    expect(recordInputCustody(db, 'wiki/b.md', 'same bytes', roots).ok).toBe(true);
    expect(invalidateInputCustody(db, 'wiki/a.md').ok).toBe(true);
    expect(readInputCustody(db, 'wiki/a.md', 'same bytes').ok).toBe(false);
    expect(readInputCustody(db, 'wiki/b.md', 'same bytes').ok).toBe(true);
    expect(invalidateInputCustody(db, 'wiki/missing.md').ok).toBe(true);
  });
  it.each(['x' + 'a'.repeat(64), 'a'.repeat(64) + 'x', 'a'.repeat(63), 'g'.repeat(64)])(
    'refuses malformed hash %s even if a corrupt catalog agrees',
    (invalidHash) => {
      db.prepare('UPDATE sources SET hash = ? WHERE id = ?').run(invalidHash, 'public');
      expect(
        recordInputCustody(db, 'wiki/a.md', 'output', [
          { sourceId: 'public', contentHash: invalidHash },
        ]).ok,
      ).toBe(false);
      expect(db.prepare('SELECT * FROM compilation_input_custody').all()).toEqual([]);
    },
  );
  it.each([
    null,
    'untyped',
    { sourceId: 'public', contentHash: hash('public material'), profile: 'caller-selected' },
    { sourceId: '', contentHash: hash('public material') },
  ])('refuses malformed root %j without persisting a receipt', (invalid) => {
    expect(
      recordInputCustody(db, 'wiki/a.md', 'output', [invalid as unknown as CustodyRoot]).ok,
    ).toBe(false);
    expect(db.prepare('SELECT * FROM compilation_input_custody').all()).toEqual([]);
  });
  it('retains every supplied input independently of advisory attribution', () => {
    expect(recordInputCustody(db, 'wiki/a.md', 'output naming only public', roots).ok).toBe(true);
    expect(readInputCustody(db, 'wiki/a.md', 'output naming only public')).toEqual({
      ok: true,
      value: roots,
    });
    const input = readInputCustody(db, 'wiki/a.md', 'output naming only public');
    if (!input.ok) throw input.error;
    expect(
      recordInputCustody(db, 'wiki/merged.md', 'merged output', [...input.value, ...roots]).ok,
    ).toBe(true);
    expect(readInputCustody(db, 'wiki/merged.md', 'merged output')).toEqual({
      ok: true,
      value: roots,
    });
  });
  it('refuses missing custody and byte changes, including whitespace', () => {
    expect(readInputCustody(db, 'wiki/legacy.md', 'legacy').ok).toBe(false);
    expect(recordInputCustody(db, 'wiki/a.md', 'output', roots).ok).toBe(true);
    expect(readInputCustody(db, 'wiki/a.md', 'output ').ok).toBe(false);
    expect(readInputCustody(db, 'wiki/alias.md', 'output').ok).toBe(false);
    expect(sourceInputCustody(db, 'public', 'public material')).toEqual({
      ok: true,
      value: [roots[0]],
    });
    expect(sourceInputCustody(db, 'public', 'modified material').ok).toBe(false);
  });
  it('detects removed input records and changed source registration', () => {
    expect(recordInputCustody(db, 'wiki/a.md', 'output', roots).ok).toBe(true);
    db.prepare('UPDATE compilation_input_custody SET roots_json = ?').run(
      JSON.stringify([roots[0]]),
    );
    expect(readInputCustody(db, 'wiki/a.md', 'output').ok).toBe(false);
    expect(recordInputCustody(db, 'wiki/a.md', 'output', roots).ok).toBe(true);
    db.prepare('UPDATE sources SET hash = ? WHERE id = ?').run(hash('changed'), 'restricted');
    expect(readInputCustody(db, 'wiki/a.md', 'output').ok).toBe(false);
  });
  it('rejects empty, ambiguous and missing inputs without replacing a prior record', () => {
    expect(recordInputCustody(db, 'wiki/a.md', 'output', roots).ok).toBe(true);
    const before = db.serialize();
    for (const invalid of [
      [],
      [{ sourceId: 'missing', contentHash: hash('x') }],
      [...roots, { sourceId: 'public', contentHash: hash('conflict') }],
    ]) {
      expect(recordInputCustody(db, 'wiki/a.md', 'changed', invalid).ok).toBe(false);
      expect(db.serialize().equals(before)).toBe(true);
    }
  });
});
