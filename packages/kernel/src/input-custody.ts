import { createHash } from 'node:crypto';

import { err, ok, type Result } from '@ico/types';

import type { Database } from './state.js';

/** Exact source version seen by a deterministic pass, not a sensitivity decision. */
export interface CustodyRoot {
  sourceId: string;
  contentHash: string;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function canonicalRoots(value: unknown): CustodyRoot[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Missing input custody');
  const roots = new Map<string, CustodyRoot>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw new Error('Invalid input custody');
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !== 'contentHash,sourceId' ||
      typeof item['sourceId'] !== 'string' ||
      item['sourceId'].length === 0 ||
      !validHash(item['contentHash'])
    )
      throw new Error('Invalid input custody');
    const prior = roots.get(item['sourceId']);
    if (prior && prior.contentHash !== item['contentHash'])
      throw new Error('Conflicting source versions in input custody');
    roots.set(item['sourceId'], { sourceId: item['sourceId'], contentHash: item['contentHash'] });
  }
  return [...roots.values()].sort((a, b) =>
    a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
  );
}

function verifyRoots(db: Database, roots: CustodyRoot[]): void {
  const read = db.prepare('SELECT hash FROM sources WHERE id = ?');
  for (const root of roots) {
    const row = read.get(root.sourceId) as { hash: string } | undefined;
    if (!row || row.hash !== root.contentHash)
      throw new Error('Source custody is missing or stale');
  }
}

const commitment = (path: string, outputHash: string, roots: CustodyRoot[]) =>
  digest(JSON.stringify(['ico-input-custody-v1', path, outputHash, roots]));

/** Trusted-host primitive. Caller must supply ALL actual inputs, never model attribution.
 * Local checks detect drift; a store writer can rewrite records and their hashes.
 * Source registration is not authenticated capture and grants no signing authority.
 */
export function recordInputCustody(
  db: Database,
  outputPath: string,
  outputContent: string,
  inputRoots: readonly CustodyRoot[],
): Result<void, Error> {
  try {
    const roots = canonicalRoots(inputRoots);
    const outputHash = digest(outputContent);
    db.transaction(() => {
      verifyRoots(db, roots);
      db.prepare(
        `INSERT INTO compilation_input_custody VALUES (?, ?, ?, ?)
        ON CONFLICT(output_path) DO UPDATE SET output_hash=excluded.output_hash,
        roots_json=excluded.roots_json, record_hash=excluded.record_hash`,
      ).run(
        outputPath,
        outputHash,
        JSON.stringify(roots),
        commitment(outputPath, outputHash, roots),
      );
    })();
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Refuse legacy pages, changed bytes, invalid records and stale source versions. */
export function readInputCustody(
  db: Database,
  outputPath: string,
  outputContent: string,
): Result<CustodyRoot[], Error> {
  try {
    const row = db
      .prepare('SELECT * FROM compilation_input_custody WHERE output_path = ?')
      .get(outputPath) as
      | { output_hash: string; roots_json: string; record_hash: string }
      | undefined;
    if (!row || row.output_hash !== digest(outputContent))
      throw new Error('Output custody is missing or stale');
    const roots = canonicalRoots(JSON.parse(row.roots_json));
    if (row.record_hash !== commitment(outputPath, row.output_hash, roots))
      throw new Error('Input custody commitment mismatch');
    verifyRoots(db, roots);
    return ok(roots);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Root binding checks the actual text supplied to the pass against registered bytes. */
export function sourceInputCustody(
  db: Database,
  sourceId: string,
  sourceContent: string,
): Result<CustodyRoot[], Error> {
  try {
    const roots = [{ sourceId, contentHash: digest(sourceContent) }];
    verifyRoots(db, roots);
    return ok(roots);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
