/** Trusted-host filesystem capture. Catalog custody is the host operator's responsibility.
 * This binds an approved local source context, not a remote repository's authenticity.
 * It grants no signing, enrollment, disclosure bypass or promotion authority.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { err, ok, type Result } from '@ico/types';

import type { Database } from './state.js';

interface CaptureRoot {
  id: string;
  path: string;
  device: string;
  inode: string;
  repositoryId: string;
  profileId: string;
  profileRevision: number;
  profileDigest: string;
}
interface Catalog {
  version: 1;
  id: string;
  revision: number;
  roots: CaptureRoot[];
}
export interface CaptureBinding {
  catalogId: string;
  catalogRevision: number;
  catalogDigest: string;
  rootId: string;
  repositoryId: string;
  profileId: string;
  profileRevision: number;
  profileDigest: string;
  sourcePathDigest: string;
}
/** Opaque process-local evidence; structurally forged objects are refused. */
export interface CaptureEvidence {
  readonly kind: 'ico-captured-source-v1';
}
interface EvidenceRecord {
  catalogPath: string;
  catalogDigest: string;
  hash: string;
  binding: CaptureBinding;
}
const evidence = new WeakMap<CaptureEvidence, EvidenceRecord>();
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function fail(): never {
  throw new Error('Source capture custody is unavailable, invalid or stale.');
}
const contains = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail();
  return value;
};
const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== keys.sort().join(',')) fail();
  return record;
}
export function readStableCaptureBytes(
  path: string,
  maximum?: number,
): { bytes: Buffer; mode: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || (maximum !== undefined && before.size > BigInt(maximum))) fail();
    // Linux's descriptor path proves which file was opened despite pathname races.
    if (process.platform !== 'linux' || realpathSync(`/proc/self/fd/${fd}`) !== path) fail();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = statSync(path, { bigint: true });
    if (
      realpathSync(`/proc/self/fd/${fd}`) !== path ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      fail();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.length) !== after.size ||
      (maximum !== undefined && bytes.length > maximum)
    )
      fail();
    return { bytes, mode: Number(after.mode & 0o777n) };
  } finally {
    closeSync(fd);
  }
}
function loadCatalog(path: string): { catalog: Catalog; digest: string } {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) fail();
  // The catalog and its immediate directory must be operator-controlled.
  for (const target of [path, dirname(path)]) {
    const st = statSync(target);
    if ((st.mode & 0o022) !== 0 || (st.uid !== process.getuid?.() && st.uid !== 0)) fail();
  }
  const { bytes } = readStableCaptureBytes(path, 1024 * 1024);
  const text = bytes.toString('utf8');
  const parsed: unknown = JSON.parse(text);
  // Restrict catalog encoding so duplicate keys and invalid UTF-8 cannot be silently normalized.
  if (
    !Buffer.from(text).equals(bytes) ||
    (text.trim() !== JSON.stringify(parsed) && text.trim() !== JSON.stringify(parsed, null, 2))
  )
    fail();
  const raw = object(parsed, ['version', 'id', 'revision', 'roots']);
  if (
    raw['version'] !== 1 ||
    !Array.isArray(raw['roots']) ||
    raw['roots'].length < 1 ||
    raw['roots'].length > 256
  )
    fail();
  const roots = (raw['roots'] as unknown[]).map((item): CaptureRoot => {
    const r = object(item, [
      'id',
      'path',
      'device',
      'inode',
      'repositoryId',
      'profileId',
      'profileRevision',
      'profileDigest',
    ]);
    const path = r['path'];
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path !== resolve(path) ||
      realpathSync(path) !== path
    )
      fail();
    const st = statSync(path, { bigint: true });
    if (!st.isDirectory() || r['device'] !== String(st.dev) || r['inode'] !== String(st.ino))
      fail();
    return {
      id: identifier(r['id']),
      path: path,
      device: String(st.dev),
      inode: String(st.ino),
      repositoryId: identifier(r['repositoryId']),
      profileId: identifier(r['profileId']),
      profileRevision: revision(r['profileRevision']),
      profileDigest: digest(r['profileDigest']),
    };
  });
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]!;
      const b = roots[j]!;
      if (
        a.id === b.id ||
        a.path === b.path ||
        contains(a.path, b.path) ||
        contains(b.path, a.path)
      )
        fail();
    }
  return {
    catalog: { version: 1, id: identifier(raw['id']), revision: revision(raw['revision']), roots },
    digest: hash(Buffer.concat([Buffer.from('ico-capture-catalog-v1\0'), bytes])),
  };
}
/** Read exactly one approved file snapshot. No store or audit writes occur here. */
export function captureSource(
  filePath: string,
  catalogPath: string,
  maximum?: number,
): Result<
  {
    bytes: Buffer;
    mode: number;
    evidence: CaptureEvidence;
  },
  Error
> {
  try {
    const loaded = loadCatalog(catalogPath);
    const actual = realpathSync(filePath);
    const root = loaded.catalog.roots.find((r) => contains(r.path, actual));
    if (!root) fail();
    // Also require the supplied pathname inside the same approved root.
    if (!contains(root.path, resolve(filePath))) fail();
    const captured = readStableCaptureBytes(actual, maximum);
    if (loadCatalog(catalogPath).digest !== loaded.digest) fail();
    const binding: CaptureBinding = {
      catalogId: loaded.catalog.id,
      catalogRevision: loaded.catalog.revision,
      catalogDigest: loaded.digest,
      rootId: root.id,
      repositoryId: root.repositoryId,
      profileId: root.profileId,
      profileRevision: root.profileRevision,
      profileDigest: root.profileDigest,
      sourcePathDigest: hash(actual),
    };
    const token: CaptureEvidence = Object.freeze({ kind: 'ico-captured-source-v1' });
    evidence.set(token, {
      catalogPath,
      catalogDigest: loaded.digest,
      hash: hash(captured.bytes),
      binding,
    });
    return ok({ ...captured, evidence: token });
  } catch {
    return err(new Error('Source capture refused: invalid source or operator catalog.'));
  }
}
/** Recheck the operator catalog and captured byte hash before persistence. */
export function validateCaptureEvidence(
  token: CaptureEvidence,
  contentHash: string,
): Result<void, Error> {
  try {
    const record = evidence.get(token);
    if (
      !record ||
      record.hash !== contentHash ||
      loadCatalog(record.catalogPath).digest !== record.catalogDigest
    )
      fail();
    return ok(undefined);
  } catch {
    return err(new Error('Source capture refused: evidence or operator catalog changed.'));
  }
}
function parseBinding(value: unknown): CaptureBinding {
  const r = object(value, [
    'catalogId',
    'catalogRevision',
    'catalogDigest',
    'rootId',
    'repositoryId',
    'profileId',
    'profileRevision',
    'profileDigest',
    'sourcePathDigest',
  ]);
  return {
    catalogId: identifier(r['catalogId']),
    catalogRevision: revision(r['catalogRevision']),
    catalogDigest: digest(r['catalogDigest']),
    rootId: identifier(r['rootId']),
    repositoryId: identifier(r['repositoryId']),
    profileId: identifier(r['profileId']),
    profileRevision: revision(r['profileRevision']),
    profileDigest: digest(r['profileDigest']),
    sourcePathDigest: digest(r['sourcePathDigest']),
  };
}
const bindingKey = (binding: CaptureBinding): string => JSON.stringify(binding);
const commitment = (
  sourceId: string,
  contentHash: string,
  unknown: number,
  bindings: CaptureBinding[],
): string =>
  hash(JSON.stringify(['ico-capture-custody-v1', sourceId, contentHash, unknown, bindings]));
function readRecord(
  db: Database,
  sourceId: string,
  contentHash: string,
): { unknown: number; bindings: CaptureBinding[] } | undefined {
  const row = db
    .prepare('SELECT * FROM source_capture_custody WHERE source_id = ?')
    .get(sourceId) as
    | { content_hash: string; unknown_origin: number; bindings_json: string; record_hash: string }
    | undefined;
  if (!row) return undefined;
  if (row.content_hash !== contentHash || ![0, 1].includes(row.unknown_origin)) fail();
  const raw: unknown = JSON.parse(row.bindings_json);
  if (!Array.isArray(raw) || raw.length > 256) fail();
  const bindings = raw.map(parseBinding);
  const keys = bindings.map(bindingKey);
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify([...keys].sort()) !== JSON.stringify(keys) ||
    row.record_hash !== commitment(sourceId, contentHash, row.unknown_origin, bindings)
  )
    fail();
  return { unknown: row.unknown_origin, bindings };
}
/** Internal registry hook: call inside the same transaction as source registration. */
export function recordSourceCapture(
  db: Database,
  sourceId: string,
  contentHash: string,
  fresh: boolean,
  token?: CaptureEvidence,
): void {
  const prior = readRecord(db, sourceId, contentHash);
  const unknown = prior?.unknown === 1 || (!prior && !fresh) || !token ? 1 : 0;
  const bindings = new Map(
    (prior?.bindings ?? []).map((binding) => [bindingKey(binding), binding]),
  );
  if (token) {
    const valid = validateCaptureEvidence(token, contentHash);
    if (!valid.ok) throw valid.error;
    const binding = evidence.get(token)!.binding;
    bindings.set(bindingKey(binding), binding);
  }
  if (bindings.size > 256) fail();
  const sorted = [...bindings.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, b]) => b);
  if (
    prior &&
    prior.unknown === unknown &&
    JSON.stringify(prior.bindings) === JSON.stringify(sorted)
  )
    return;
  db.prepare(
    `INSERT INTO source_capture_custody VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET unknown_origin=excluded.unknown_origin,
    bindings_json=excluded.bindings_json, record_hash=excluded.record_hash`,
  ).run(
    sourceId,
    contentHash,
    unknown,
    JSON.stringify(sorted),
    commitment(sourceId, contentHash, unknown, sorted),
  );
}
/** Resolve every recorded origin against current operator configuration; never select one. */
export function readSourceCaptureBindings(
  db: Database,
  sourceId: string,
  contentHash: string,
  catalogPath: string,
): Result<CaptureBinding[], Error> {
  try {
    const source = db.prepare('SELECT hash FROM sources WHERE id = ?').get(sourceId) as
      | { hash: string }
      | undefined;
    if (!source || source.hash !== contentHash) fail();
    const record = readRecord(db, sourceId, contentHash);
    if (!record || record.unknown !== 0 || record.bindings.length === 0) fail();
    const loaded = loadCatalog(catalogPath);
    for (const binding of record.bindings) {
      const root = loaded.catalog.roots.find((r) => r.id === binding.rootId);
      if (
        !root ||
        binding.catalogDigest !== loaded.digest ||
        binding.catalogId !== loaded.catalog.id ||
        binding.catalogRevision !== loaded.catalog.revision ||
        binding.repositoryId !== root.repositoryId ||
        binding.profileId !== root.profileId ||
        binding.profileRevision !== root.profileRevision ||
        binding.profileDigest !== root.profileDigest
      )
        fail();
    }
    return ok(record.bindings);
  } catch {
    return err(new Error('Source capture custody is unavailable, invalid or stale.'));
  }
}
