/**
 * Spool emitter — ICO writer side of the ICO → INTKB spool boundary.
 *
 * Emits compiled L2 / L4 artifacts to a spool directory as JSONL files that
 * INTKB's `ingestFromSpool` reads. Architecture and design decisions in
 * `000-docs/034-AT-NTRP-ecosystem-thesis.md` §4 and the Decision Record at
 * `000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md` §4.1.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * Design highlights enforced here (from the 5-agent design review):
 *  - Atomic write via `.tmp + rename` (consistent with the rest of the kernel).
 *  - Deterministic UUID v5 for candidate IDs — re-emitting an unchanged page
 *    produces the same ID; INTKB id-dedupe silently skips.
 *  - Per-emission timestamp file (`spool-YYYY-MM-DDTHHMMSSZ.jsonl`), NOT append
 *    to a dated file (atomicity would be lost on append).
 *  - Manifest sidecar (`<spool-file>.manifest.json`) carries SHA-256 of the
 *    spool file so drift is detectable without an inline round-trip.
 *  - Two trace events: `spool.emit.start` (count + scope) and
 *    `spool.emit.complete` (count + bytes + spool file SHA-256).
 *  - Content hard-cap at `SPOOL_CONTENT_MAX_BYTES` (64 KB); rejects (does NOT
 *    truncate) larger candidates. Truncation in a security boundary is an
 *    anti-pattern.
 *  - `tenantId` is REQUIRED; no fallback. Caller passes it; absent → err.
 *  - Exhaustive switch on the 7 compiled-page types with explicit handling for
 *    all of them (no silent skips). `semantic-index` is skip-with-trace.
 *
 * @module spool
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Database } from 'better-sqlite3';
import matter from 'gray-matter';

import {
  type CompiledPageType,
  err,
  ICO_AUTHOR,
  ok,
  type Result,
  SPOOL_CONTENT_MAX_BYTES,
  SPOOL_UUID_NAMESPACE,
  type SpoolMemoryCandidate,
  SpoolMemoryCandidateSchema,
  type SpoolMemoryCategory,
} from '@ico/types';

import { writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Subset of compiled artifacts the emitter operates over. */
export type SpoolEmitScope = 'wiki' | 'outputs' | 'all';

/** Options accepted by `emitSpool`. */
export interface SpoolEmitOptions {
  /**
   * Workspace-relative or absolute path to the spool directory to emit into.
   * If absolute, must resolve to a path inside the workspace OR `$TEAMKB_HOME`
   * (validated by the CLI layer before invocation — see spool command).
   * If relative, resolved against `workspacePath`.
   * Default: `<workspacePath>/spool`.
   */
  outDir?: string;
  /** Which compiled artifacts to emit. */
  scope: SpoolEmitScope;
  /**
   * Tenant identifier emitted on every candidate. REQUIRED — there is no
   * default. The CLI layer enforces this (refuses to emit if absent from
   * workspace config). Per CISO seat in 035-AT-DECR §2.5 + agent BLOCK fix #2.
   */
  tenantId: string;
}

/** Reason a candidate was skipped during emission. */
export interface SpoolSkipReason {
  /** Workspace-relative path of the compiled page that was skipped. */
  path: string;
  /** Machine-readable skip reason code. */
  code:
    | 'CONTENT_TOO_LARGE'
    | 'EMPTY_CONTENT'
    | 'MISSING_TITLE'
    | 'MISSING_TYPE'
    | 'UNMAPPED_PAGE_TYPE'
    | 'SEMANTIC_INDEX_SKIPPED'
    | 'INVALID_CANDIDATE';
  /** Human-readable detail. */
  detail: string;
}

/** Successful emission summary. */
export interface SpoolEmitResult {
  /** Absolute path of the spool JSONL file written. */
  spoolFile: string;
  /** Absolute path of the manifest sidecar. */
  manifestFile: string;
  /** Number of candidates written to the spool file. */
  emittedCount: number;
  /** Per-candidate skip reasons surfaced for operator visibility. */
  skipped: SpoolSkipReason[];
  /** SHA-256 hex digest of the spool file content. */
  spoolFileSha256: string;
  /** Byte size of the spool file. */
  spoolFileBytes: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Typed errors `emitSpool` returns via the `Result` shape. */
export class SpoolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'WORKSPACE_NOT_FOUND'
      | 'WIKI_NOT_FOUND'
      | 'OUTPUTS_NOT_FOUND'
      | 'WRITE_FAILED'
      | 'MANIFEST_FAILED'
      | 'TRACE_FAILED'
      | 'NO_TENANT_ID',
  ) {
    super(message);
    this.name = 'SpoolError';
  }
}

// ---------------------------------------------------------------------------
// Internal: UUID v5 (RFC 4122, name-based with SHA-1)
// ---------------------------------------------------------------------------

/** Parse a UUID string into a 16-byte Buffer. */
function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/** Format a 16-byte Buffer back into a canonical UUID string. */
function uuidBytesToString(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Compute a deterministic UUID v5 from `(namespace, name)` per RFC 4122 §4.3.
 * SHA-1 of (namespace bytes || name UTF-8 bytes), truncated to 16 bytes,
 * with version (5) and variant (RFC 4122) bits patched.
 *
 * Node's built-in `crypto.randomUUID()` is v4 only; there is no native v5,
 * so this is a small inline implementation rather than a third-party dep.
 */
function uuidV5(namespace: string, name: string): string {
  const nsBytes = uuidStringToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5: top 4 bits of byte 6 = 0101
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122: top 2 bits of byte 8 = 10
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return uuidBytesToString(bytes);
}

// ---------------------------------------------------------------------------
// Internal: page-type → category mapping (exhaustive)
// ---------------------------------------------------------------------------

/**
 * Result of mapping a compiled page type to an INTKB `MemoryCategory`.
 * `null` means the page type was deliberately skipped (e.g. `semantic-index`).
 */
type CategoryMapResult =
  | { category: SpoolMemoryCategory }
  | { skip: 'SEMANTIC_INDEX_SKIPPED' | 'UNMAPPED_PAGE_TYPE'; detail: string };

/**
 * Exhaustive mapping from ICO compiled-page types to INTKB memory categories.
 * Every value in `CompiledPageType` MUST be handled here; the `default` arm
 * surfaces a SKIPPED_UNMAPPED_TYPE skip so a future addition to the page-type
 * enum doesn't silently disappear from the spool.
 */
function mapPageTypeToCategory(pageType: CompiledPageType): CategoryMapResult {
  switch (pageType) {
    case 'source-summary':
      return { category: 'reference' };
    case 'concept':
      return { category: 'pattern' };
    case 'topic':
      return { category: 'architecture' };
    case 'entity':
      return { category: 'reference' };
    case 'contradiction':
      return { category: 'troubleshooting' };
    case 'open-question':
      // No clean INTKB category for open questions; emit as `reference` so the
      // curator sees them, but flag in the title prefix on the candidate.
      return { category: 'reference' };
    case 'semantic-index':
      return {
        skip: 'SEMANTIC_INDEX_SKIPPED',
        detail: 'semantic-index is a derived view, not durable memory content',
      };
    default: {
      // Exhaustiveness guard — the `never` cast fires a TS error if a new
      // CompiledPageType is added without a switch case here.
      const _exhaustive: never = pageType;
      return {
        skip: 'UNMAPPED_PAGE_TYPE',
        detail: `unmapped CompiledPageType ${String(_exhaustive)} — add a case in spool.ts mapPageTypeToCategory`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: page discovery
// ---------------------------------------------------------------------------

/** Workspace-relative wiki subdirectories that contain compiled pages. */
const WIKI_DIRS = [
  'sources',
  'concepts',
  'topics',
  'entities',
  'contradictions',
  'open-questions',
] as const;

/** Workspace-relative output subdirectories that contain promotable artifacts. */
const OUTPUT_DIRS = ['reports', 'slides'] as const;

interface CompiledPage {
  /** Workspace-relative path (e.g. `wiki/concepts/foo.md`). */
  relPath: string;
  /** Absolute filesystem path. */
  absPath: string;
  /** Frontmatter as parsed by gray-matter. */
  frontmatter: Record<string, unknown>;
  /** Body content (post-frontmatter). */
  body: string;
  /** Computed SHA-256 of the body. */
  bodySha256: string;
}

function readCompiledPagesIn(
  workspacePath: string,
  subdirs: ReadonlyArray<string>,
  parent: 'wiki' | 'outputs',
): CompiledPage[] {
  const pages: CompiledPage[] = [];
  for (const sub of subdirs) {
    const dirAbs = join(workspacePath, parent, sub);
    if (!existsSync(dirAbs)) continue;
    let files: string[];
    try {
      files = readdirSync(dirAbs).filter((f) => f.endsWith('.md') && f !== '.gitkeep');
    } catch {
      continue;
    }
    for (const filename of files) {
      const absPath = join(dirAbs, filename);
      try {
        const raw = readFileSync(absPath, 'utf-8');
        const parsed = matter(raw);
        const body = parsed.content.trim();
        const bodySha256 = createHash('sha256').update(body).digest('hex');
        pages.push({
          relPath: `${parent}/${sub}/${filename}`,
          absPath,
          frontmatter: parsed.data,
          body,
          bodySha256,
        });
      } catch {
        // Unreadable / unparseable files are silently dropped from discovery —
        // the equivalent failure mode is already accepted by INTKB's reader.
        // The kernel's job here is to emit what's emittable, not to fix corpus
        // integrity issues. A future `ico lint` extension can flag those.
        continue;
      }
    }
  }
  return pages;
}

/**
 * The "page type" string we use for mapping. For wiki pages this is the
 * `type` field in frontmatter. For outputs (reports/slides) we fall back to
 * the subdirectory name. Outputs are mapped onto `topic` for category
 * purposes since they are cross-source synthesis artifacts.
 */
function inferPageType(page: CompiledPage, parent: 'wiki' | 'outputs'): CompiledPageType | null {
  if (parent === 'outputs') {
    // Reports + slides → treat as topic-equivalent. Returning a real value
    // from CompiledPageType keeps the exhaustive switch in
    // mapPageTypeToCategory honest.
    return 'topic';
  }
  const t = page.frontmatter['type'];
  if (typeof t !== 'string') return null;
  // Validated via the exhaustive switch in mapPageTypeToCategory.
  switch (t) {
    case 'source-summary':
    case 'concept':
    case 'topic':
    case 'entity':
    case 'contradiction':
    case 'open-question':
    case 'semantic-index':
      return t;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: candidate builder
// ---------------------------------------------------------------------------

/** Build a SpoolMemoryCandidate from a discovered compiled page. */
function buildCandidate(
  page: CompiledPage,
  pageType: CompiledPageType,
  category: SpoolMemoryCategory,
  tenantId: string,
  workspaceId: string,
): SpoolMemoryCandidate {
  const titleRaw = page.frontmatter['title'];
  const title =
    typeof titleRaw === 'string' && titleRaw.trim() !== ''
      ? titleRaw.trim()
      : basename(page.relPath, '.md');
  // Prefix open-question titles so the curator sees them as questions.
  const finalTitle = pageType === 'open-question' ? `Open question: ${title}` : title;
  const candidateId = uuidV5(
    SPOOL_UUID_NAMESPACE,
    `${workspaceId}\x00${page.relPath}\x00${page.bodySha256}`,
  );

  const tagsRaw = page.frontmatter['tags'];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(t))
    : [];

  return {
    schemaVersion: '1',
    id: candidateId,
    status: 'inbox',
    source: 'import',
    content: page.body,
    title: finalTitle,
    category,
    trustLevel: 'medium',
    author: ICO_AUTHOR,
    tenantId,
    metadata: {
      filePaths: [page.relPath],
      projectContext: 'intentional-cognition-os',
      tags,
    },
    prePolicyFlags: {
      // Defaults to false. INTKB's curator-stage policy engine is the secret
      // detection trust anchor (per 035-AT-DECR §2.5(1) and 036-AT-THRT spec
      // when it lands). ICO does NOT pretend to do secret detection here.
      potentialSecret: false,
      lowConfidence: false,
      duplicateSuspect: false,
    },
    capturedAt: new Date().toISOString(), // Zod 4 datetime requires Z-suffix
  };
}

// ---------------------------------------------------------------------------
// Internal: atomic write + manifest
// ---------------------------------------------------------------------------

function spoolFilename(now: Date): string {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  // iso is now `YYYYMMDDTHHMMSSZ`; reformat to readable spool-YYYY-MM-DDTHHMMSSZ
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(4, 6);
  const dd = iso.slice(6, 8);
  const t = iso.slice(8);
  return `spool-${yyyy}-${mm}-${dd}T${t.slice(1)}.jsonl`;
}

interface WriteOutcome {
  spoolFile: string;
  manifestFile: string;
  spoolFileSha256: string;
  spoolFileBytes: number;
}

function atomicWriteSpool(
  outDirAbs: string,
  filename: string,
  jsonlBody: string,
  candidateIds: string[],
  emittedAt: string,
  schemaVersion: string,
): Result<WriteOutcome, Error> {
  const spoolFile = join(outDirAbs, filename);
  const spoolTmp = `${spoolFile}.tmp`;
  const manifestFile = `${spoolFile}.manifest.json`;
  const manifestTmp = `${manifestFile}.tmp`;
  // FD-based open + write — mirrors the canonical CodeQL-accepted form used
  // by kernel/src/audit/writeTrace.ts (v1.5.1–2). O_EXCL guarantees the .tmp
  // path does not already exist, defeating a symlink-swap TOCTOU.
  // CodeQL js/insecure-temporary-file accepts this form; it does not accept
  // writeFileSync(..., { flag: 'wx' }) as an O_EXCL equivalent even though
  // the runtime semantics are identical.
  const O_FLAGS = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
  const MODE = 0o600;
  let spoolFd = -1;
  let manifestFd = -1;
  try {
    spoolFd = openSync(spoolTmp, O_FLAGS, MODE);
    writeSync(spoolFd, jsonlBody, null, 'utf-8');
    const bytes = fstatSync(spoolFd).size;
    closeSync(spoolFd);
    spoolFd = -1;
    renameSync(spoolTmp, spoolFile);

    const sha256 = createHash('sha256').update(jsonlBody, 'utf-8').digest('hex');
    const manifest = {
      schemaVersion,
      emittedAt,
      emittedCount: candidateIds.length,
      spoolFile: filename,
      spoolFileBytes: bytes,
      spoolFileSha256: sha256,
      candidateIds,
    };
    manifestFd = openSync(manifestTmp, O_FLAGS, MODE);
    writeSync(manifestFd, JSON.stringify(manifest, null, 2) + '\n', null, 'utf-8');
    closeSync(manifestFd);
    manifestFd = -1;
    renameSync(manifestTmp, manifestFile);

    return ok({ spoolFile, manifestFile, spoolFileSha256: sha256, spoolFileBytes: bytes });
  } catch (e) {
    // Ensure any FD opened above is closed on the error path. The reset to -1
    // after each closeSync above means these only fire if the corresponding
    // openSync or writeSync threw before the close.
    if (spoolFd !== -1) {
      try {
        closeSync(spoolFd);
      } catch {
        /* swallow — original error wins */
      }
    }
    if (manifestFd !== -1) {
      try {
        closeSync(manifestFd);
      } catch {
        /* swallow — original error wins */
      }
    }
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a spool batch from the workspace's compiled artifacts.
 *
 * Reads compiled pages of the requested scope, maps each to a
 * `SpoolMemoryCandidate`, validates against the mirrored Zod schema, writes
 * the JSONL spool file + manifest sidecar atomically, and emits a pair of
 * `spool.emit.start` / `spool.emit.complete` trace events with the file's
 * SHA-256 in the complete payload.
 *
 * Per agent review consolidated notes, this kernel function has NO
 * `dryRun` parameter — dry-run is a CLI-layer concern (the kernel's job
 * is to emit or not emit).
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root.
 * @param opts          - Emission options. `tenantId` is REQUIRED.
 * @returns `ok(SpoolEmitResult)` on success, or `err(Error)` on failure.
 */
export function emitSpool(
  db: Database,
  workspacePath: string,
  opts: SpoolEmitOptions,
): Result<SpoolEmitResult, Error> {
  if (!existsSync(workspacePath)) {
    return err(new SpoolError(`Workspace not found at ${workspacePath}`, 'WORKSPACE_NOT_FOUND'));
  }
  if (typeof opts.tenantId !== 'string' || opts.tenantId.trim() === '') {
    return err(
      new SpoolError(
        'tenantId is required for spool emission to prevent cross-tenant data leakage. Set spool.tenantId in .ico/config.json.',
        'NO_TENANT_ID',
      ),
    );
  }

  // Resolve output directory.
  const outDirAbs = opts.outDir
    ? resolve(workspacePath, opts.outDir)
    : resolve(workspacePath, 'spool');
  if (!existsSync(outDirAbs)) {
    // Auto-create only when inside the workspace; outside paths must be
    // operator-prepared (the CLI layer also validates this).
    const inside = outDirAbs.startsWith(resolve(workspacePath) + '/');
    if (!inside) {
      return err(
        new SpoolError(
          `Spool output directory does not exist: ${outDirAbs}. Create it first or set --out to a path inside the workspace.`,
          'WRITE_FAILED',
        ),
      );
    }
    try {
      mkdirSync(outDirAbs, { recursive: true });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const workspaceId = basename(resolve(workspacePath));
  const skipped: SpoolSkipReason[] = [];
  const candidates: SpoolMemoryCandidate[] = [];

  // ---------------------------------------------------------------------
  // Stage A: discover compiled pages per requested scope
  // ---------------------------------------------------------------------
  const wantWiki = opts.scope === 'wiki' || opts.scope === 'all';
  const wantOutputs = opts.scope === 'outputs' || opts.scope === 'all';

  const discovered: Array<{ page: CompiledPage; parent: 'wiki' | 'outputs' }> = [];
  if (wantWiki) {
    for (const page of readCompiledPagesIn(workspacePath, WIKI_DIRS, 'wiki')) {
      discovered.push({ page, parent: 'wiki' });
    }
  }
  if (wantOutputs) {
    for (const page of readCompiledPagesIn(workspacePath, OUTPUT_DIRS, 'outputs')) {
      discovered.push({ page, parent: 'outputs' });
    }
  }

  // ---------------------------------------------------------------------
  // Stage B: emit start trace
  // ---------------------------------------------------------------------
  const startedAt = new Date().toISOString();
  const batchId = uuidV5(SPOOL_UUID_NAMESPACE, `batch\x00${startedAt}\x00${opts.scope}`);
  const startTrace = writeTrace(
    db,
    workspacePath,
    'spool.emit.start',
    {
      batchId,
      scope: opts.scope,
      tenantId: opts.tenantId,
      discoveredCount: discovered.length,
      outDir: outDirAbs,
    },
    { summary: `spool.emit.start: scope=${opts.scope} discovered=${discovered.length}` },
  );
  if (!startTrace.ok) {
    return err(
      new SpoolError(`Failed to write start trace: ${startTrace.error.message}`, 'TRACE_FAILED'),
    );
  }

  // ---------------------------------------------------------------------
  // Stage C: build + validate candidates
  // ---------------------------------------------------------------------
  for (const { page, parent } of discovered) {
    const pageType = inferPageType(page, parent);
    if (pageType === null) {
      skipped.push({
        path: page.relPath,
        code: 'MISSING_TYPE',
        detail: 'frontmatter type field missing or not a recognised CompiledPageType value',
      });
      continue;
    }
    const mapped = mapPageTypeToCategory(pageType);
    if ('skip' in mapped) {
      skipped.push({ path: page.relPath, code: mapped.skip, detail: mapped.detail });
      continue;
    }
    if (page.body.length === 0) {
      skipped.push({
        path: page.relPath,
        code: 'EMPTY_CONTENT',
        detail: 'body is empty after frontmatter strip',
      });
      continue;
    }
    if (Buffer.byteLength(page.body, 'utf-8') > SPOOL_CONTENT_MAX_BYTES) {
      skipped.push({
        path: page.relPath,
        code: 'CONTENT_TOO_LARGE',
        detail: `body exceeds ${SPOOL_CONTENT_MAX_BYTES} byte cap; refusing rather than truncating`,
      });
      continue;
    }
    const candidate = buildCandidate(page, pageType, mapped.category, opts.tenantId, workspaceId);
    const parsed = SpoolMemoryCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({
        path: page.relPath,
        code: 'INVALID_CANDIDATE',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }
    candidates.push(parsed.data);
  }

  // ---------------------------------------------------------------------
  // Stage D: serialise + atomic write + manifest
  // ---------------------------------------------------------------------
  const filename = spoolFilename(new Date());
  const jsonlBody =
    candidates.map((c) => JSON.stringify(c)).join('\n') + (candidates.length > 0 ? '\n' : '');
  const writeResult = atomicWriteSpool(
    outDirAbs,
    filename,
    jsonlBody,
    candidates.map((c) => c.id),
    startedAt,
    '1',
  );
  if (!writeResult.ok) {
    return err(
      new SpoolError(`Failed to write spool: ${writeResult.error.message}`, 'WRITE_FAILED'),
    );
  }
  const { spoolFile, manifestFile, spoolFileSha256, spoolFileBytes } = writeResult.value;

  // ---------------------------------------------------------------------
  // Stage E: emit complete trace
  // ---------------------------------------------------------------------
  const completeTrace = writeTrace(
    db,
    workspacePath,
    'spool.emit.complete',
    {
      batchId,
      scope: opts.scope,
      tenantId: opts.tenantId,
      emittedCount: candidates.length,
      skippedCount: skipped.length,
      spoolFile: basename(spoolFile),
      manifestFile: basename(manifestFile),
      spoolFileBytes,
      spoolFileSha256,
    },
    {
      summary: `spool.emit.complete: emitted=${candidates.length} skipped=${skipped.length} bytes=${spoolFileBytes}`,
    },
  );
  if (!completeTrace.ok) {
    return err(
      new SpoolError(
        `Failed to write complete trace: ${completeTrace.error.message}`,
        'TRACE_FAILED',
      ),
    );
  }

  return ok({
    spoolFile,
    manifestFile,
    emittedCount: candidates.length,
    skipped,
    spoolFileSha256,
    spoolFileBytes,
  });
}

/**
 * Same as `emitSpool` but does NOT write to disk — used by the CLI dry-run
 * path. Returns a structure-only summary suitable for printing; never reveals
 * candidate `content` (per agent BLOCK fix #2: dry-run prints structure
 * only to avoid streaming secrets to CI logs).
 */
export interface SpoolDryRunSummary {
  scope: SpoolEmitScope;
  tenantId: string;
  outDir: string;
  wouldEmit: Array<{
    id: string;
    title: string;
    category: SpoolMemoryCategory;
    sourcePath: string;
    contentBytes: number;
  }>;
  skipped: SpoolSkipReason[];
}

export function dryRunSpool(
  workspacePath: string,
  opts: SpoolEmitOptions,
): Result<SpoolDryRunSummary, Error> {
  if (!existsSync(workspacePath)) {
    return err(new SpoolError(`Workspace not found at ${workspacePath}`, 'WORKSPACE_NOT_FOUND'));
  }
  if (typeof opts.tenantId !== 'string' || opts.tenantId.trim() === '') {
    return err(
      new SpoolError(
        'tenantId is required for spool emission to prevent cross-tenant data leakage. Set spool.tenantId in .ico/config.json.',
        'NO_TENANT_ID',
      ),
    );
  }

  const outDirAbs = opts.outDir
    ? resolve(workspacePath, opts.outDir)
    : resolve(workspacePath, 'spool');
  const workspaceId = basename(resolve(workspacePath));
  const wouldEmit: SpoolDryRunSummary['wouldEmit'] = [];
  const skipped: SpoolSkipReason[] = [];

  const wantWiki = opts.scope === 'wiki' || opts.scope === 'all';
  const wantOutputs = opts.scope === 'outputs' || opts.scope === 'all';
  const discovered: Array<{ page: CompiledPage; parent: 'wiki' | 'outputs' }> = [];
  if (wantWiki) {
    for (const page of readCompiledPagesIn(workspacePath, WIKI_DIRS, 'wiki')) {
      discovered.push({ page, parent: 'wiki' });
    }
  }
  if (wantOutputs) {
    for (const page of readCompiledPagesIn(workspacePath, OUTPUT_DIRS, 'outputs')) {
      discovered.push({ page, parent: 'outputs' });
    }
  }

  for (const { page, parent } of discovered) {
    const pageType = inferPageType(page, parent);
    if (pageType === null) {
      skipped.push({
        path: page.relPath,
        code: 'MISSING_TYPE',
        detail: 'frontmatter type missing/invalid',
      });
      continue;
    }
    const mapped = mapPageTypeToCategory(pageType);
    if ('skip' in mapped) {
      skipped.push({ path: page.relPath, code: mapped.skip, detail: mapped.detail });
      continue;
    }
    const bytes = Buffer.byteLength(page.body, 'utf-8');
    if (page.body.length === 0) {
      skipped.push({ path: page.relPath, code: 'EMPTY_CONTENT', detail: 'body empty' });
      continue;
    }
    if (bytes > SPOOL_CONTENT_MAX_BYTES) {
      skipped.push({
        path: page.relPath,
        code: 'CONTENT_TOO_LARGE',
        detail: `${bytes} > ${SPOOL_CONTENT_MAX_BYTES}`,
      });
      continue;
    }
    const cand = buildCandidate(page, pageType, mapped.category, opts.tenantId, workspaceId);
    wouldEmit.push({
      id: cand.id,
      title: cand.title,
      category: cand.category,
      sourcePath: page.relPath,
      contentBytes: bytes,
    });
  }

  return ok({ scope: opts.scope, tenantId: opts.tenantId, outDir: outDirAbs, wouldEmit, skipped });
}
