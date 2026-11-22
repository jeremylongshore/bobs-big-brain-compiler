import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readInputCustody, recordInputCustody, sourceInputCustody } from './input-custody.js';
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
      expect(db.serialize()).toEqual(before);
    }
  });
});
