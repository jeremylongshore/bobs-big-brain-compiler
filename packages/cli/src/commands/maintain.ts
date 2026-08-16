/**
 * `ico maintain` — scan registered mounts, ingest eligible deltas, and compile
 * them under one governed write lock.
 *
 * This is intentionally separate from the agent-driven knowledge distiller.
 * A maintenance receipt can say only `compiled`, `verified_noop`, or `failure`;
 * a clean process exit is never used as a proxy for useful work.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';

import type { Command } from 'commander';

import {
  type AffectedSet,
  type ChangedFile,
  computeAffectedSet,
  createClaudeClient,
  evaluateCostGate,
} from '@ico/compiler';
import {
  closeDatabase,
  type Database,
  initDatabase,
  listMounts,
  listSources,
  loadConfig,
  scanForDisclosure,
  withWriteLock,
} from '@ico/kernel';
import type { Mount, Source } from '@ico/types';

import { formatError, formatInfo, formatJSON, formatSuccess } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';
import {
  affectedCostTypes,
  type CompileContext,
  type RawSourceProvenance,
  registerChangedWorkspaceSources,
  runAffectedPipelineUnlocked,
} from './compile.js';
import { scanDirectory } from './ingest.js';

const RECEIPT_SCHEMA_VERSION = 1;

export type MaintenanceStatus = 'compiled' | 'verified_noop' | 'failure';
export type CandidateKind = 'new' | 'changed' | 'pending';

export interface MaintenanceCandidate {
  kind: CandidateKind;
  originPath: string;
  mountId: string;
  mountName: string;
  relativePath: string;
  rawPath: string;
  hash: string;
  bytes: Buffer;
  copyRequired: boolean;
}

export interface MountScanEvidence {
  id: string;
  name: string;
  path: string;
  files: number;
  newestInputMtime: string | null;
  ageDays: number | null;
  stale: boolean;
  missing: boolean;
}

export interface MaintenanceScan {
  mounts: MountScanEvidence[];
  candidates: MaintenanceCandidate[];
  counts: {
    mounts: number;
    files: number;
    unchanged: number;
    legacyUnchanged: number;
    policyBlocked: number;
    new: number;
    changed: number;
    pending: number;
    removed: number;
  };
  removedOrigins: string[];
  staleMounts: string[];
  missingMounts: string[];
}

export interface MaintenanceReceipt {
  schemaVersion: number;
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: MaintenanceStatus | 'running';
  workspace: string;
  model: string | null;
  scan: Omit<MaintenanceScan, 'candidates'>;
  rawPaths: string[];
  plannedAffectedTypes: string[];
  compilationRowsAdded: number;
  projectedCostUsd: number | null;
  errorCode: string | null;
  error: string | null;
}

interface MaintenanceOrigin {
  mountId: string;
  mountName?: unknown;
  relativePath: string;
  originPath?: unknown;
}

interface OriginMetadata {
  maintenance?: Record<string, unknown>;
}

export interface MaintainOptions {
  scanOnly?: boolean;
  model?: string;
  dailyCeilingUsd?: string;
  debounceSeconds?: string;
  maxInputAgeDays?: string;
  lockWaitSeconds?: string;
}

interface GlobalOptions {
  workspace?: string;
  json?: boolean;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSlug(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (slug || fallback).slice(0, 80);
}

/** Build a stable collision-resistant raw path from mount identity + relative path. */
export function buildMaintenanceRawPath(
  mount: Pick<Mount, 'id' | 'name'>,
  relativePath: string,
): string {
  const extension = extname(relativePath).toLowerCase() || '.txt';
  const stem = basename(relativePath, extname(relativePath));
  const mountSlug = safeSlug(mount.name, 'mount').slice(0, 32);
  const stemSlug = safeSlug(stem, 'source');
  const identity = sha256(`${mount.id}\0${relativePath}`).slice(0, 12);
  const subdir =
    extension === '.pdf'
      ? 'papers'
      : extension === '.html' || extension === '.htm'
        ? 'articles'
        : 'notes';
  return `raw/${subdir}/${mountSlug}-${stemSlug}-${identity}${extension}`;
}

function parseOrigin(source: Source): MaintenanceOrigin | null {
  if (source.metadata === null) return null;
  try {
    const parsed = JSON.parse(source.metadata) as OriginMetadata;
    const value = parsed.maintenance;
    if (
      value === undefined ||
      typeof value['mountId'] !== 'string' ||
      typeof value['relativePath'] !== 'string'
    ) {
      return null;
    }
    return {
      mountId: value['mountId'],
      relativePath: value['relativePath'],
      ...(value['mountName'] !== undefined && { mountName: value['mountName'] }),
      ...(value['originPath'] !== undefined && { originPath: value['originPath'] }),
    };
  } catch {
    return null;
  }
}

function originKey(mountId: string, relativePath: string): string {
  return `${mountId}\0${relativePath}`;
}

function newestSourceByOrigin(sources: Source[]): Map<string, Source> {
  const result = new Map<string, Source>();
  for (const source of sources) {
    const origin = parseOrigin(source);
    if (
      origin === null ||
      typeof origin.mountId !== 'string' ||
      typeof origin.relativePath !== 'string'
    ) {
      continue;
    }
    const key = originKey(origin.mountId, origin.relativePath);
    const current = result.get(key);
    if (current === undefined || current.ingested_at < source.ingested_at) result.set(key, source);
  }
  return result;
}

function sourceIdsWithSummaries(db: Database): Set<string> {
  const rows = db
    .prepare<[], { source_id: string }>(
      `SELECT DISTINCT source_id
         FROM compilations
        WHERE type = 'summary' AND source_id IS NOT NULL`,
    )
    .all();
  return new Set(rows.map((row) => row.source_id));
}

/**
 * Scan every registered mount. Content hashes are authoritative; mtimes are
 * retained only as liveness evidence. Policy-blocked files are counted as an
 * explicit governed outcome, never as an ingest error or silent omission.
 */
export function scanMountedSources(
  db: Database,
  workspacePath: string,
  options?: { maxInputAgeDays?: number; nowMs?: number },
): MaintenanceScan {
  const mountsResult = listMounts(db);
  if (!mountsResult.ok) throw mountsResult.error;
  const sourcesResult = listSources(db);
  if (!sourcesResult.ok) throw sourcesResult.error;

  const mounts = mountsResult.value;
  const sources = sourcesResult.value;
  const compiledSourceIds = sourceIdsWithSummaries(db);
  const trackedByOrigin = newestSourceByOrigin(sources);
  const sourcesByHash = new Map<string, Source[]>();
  for (const source of sources) {
    const rows = sourcesByHash.get(source.hash) ?? [];
    rows.push(source);
    sourcesByHash.set(source.hash, rows);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const maxAge = options?.maxInputAgeDays ?? 0;
  const seenOrigins = new Set<string>();
  const evidence: MountScanEvidence[] = [];
  const candidates: MaintenanceCandidate[] = [];
  const counts = {
    mounts: mounts.length,
    files: 0,
    unchanged: 0,
    legacyUnchanged: 0,
    policyBlocked: 0,
    new: 0,
    changed: 0,
    pending: 0,
    removed: 0,
  };

  for (const mount of mounts) {
    if (!existsSync(mount.path)) {
      evidence.push({
        id: mount.id,
        name: mount.name,
        path: mount.path,
        files: 0,
        newestInputMtime: null,
        ageDays: null,
        stale: false,
        missing: true,
      });
      continue;
    }

    const files = Array.from(new Set(scanDirectory(mount.path, { respectGitIgnore: true }))).sort();
    let newestMtimeMs = 0;
    for (const file of files) {
      counts.files++;
      const relativePath = relative(mount.path, file);
      const key = originKey(mount.id, relativePath);
      seenOrigins.add(key);

      const bytes = readFileSync(file);
      const hash = sha256(bytes);
      newestMtimeMs = Math.max(newestMtimeMs, statSync(file).mtimeMs);
      if (scanForDisclosure(bytes.toString('utf-8')) !== null) {
        counts.policyBlocked++;
        continue;
      }

      const tracked = trackedByOrigin.get(key);
      if (tracked !== undefined) {
        if (tracked.hash === hash && compiledSourceIds.has(tracked.id)) {
          counts.unchanged++;
          continue;
        }
        const kind: CandidateKind = tracked.hash === hash ? 'pending' : 'changed';
        counts[kind]++;
        candidates.push({
          kind,
          originPath: file,
          mountId: mount.id,
          mountName: mount.name,
          relativePath,
          rawPath: tracked.path,
          hash,
          bytes,
          copyRequired: kind === 'changed' || !existsSync(join(workspacePath, tracked.path)),
        });
        continue;
      }

      const legacyMatches = sourcesByHash.get(hash) ?? [];
      const compiledLegacy = legacyMatches.find((source) => compiledSourceIds.has(source.id));
      if (compiledLegacy !== undefined) {
        counts.legacyUnchanged++;
        continue;
      }
      const pendingLegacy = legacyMatches.find((source) =>
        existsSync(join(workspacePath, source.path)),
      );
      const kind: CandidateKind = pendingLegacy === undefined ? 'new' : 'pending';
      counts[kind]++;
      candidates.push({
        kind,
        originPath: file,
        mountId: mount.id,
        mountName: mount.name,
        relativePath,
        rawPath: pendingLegacy?.path ?? buildMaintenanceRawPath(mount, relativePath),
        hash,
        bytes,
        copyRequired: pendingLegacy === undefined,
      });
    }

    const ageDays = newestMtimeMs > 0 ? (nowMs - newestMtimeMs) / 86_400_000 : null;
    const stale = maxAge > 0 && (ageDays === null || ageDays > maxAge);
    evidence.push({
      id: mount.id,
      name: mount.name,
      path: mount.path,
      files: files.length,
      newestInputMtime: newestMtimeMs > 0 ? new Date(newestMtimeMs).toISOString() : null,
      ageDays,
      stale,
      missing: false,
    });
  }

  const currentMountIds = new Set(mounts.map((mount) => mount.id));
  const removedOrigins: string[] = [];
  for (const [key, source] of trackedByOrigin) {
    const origin = parseOrigin(source);
    if (
      origin !== null &&
      typeof origin.mountId === 'string' &&
      currentMountIds.has(origin.mountId) &&
      !seenOrigins.has(key)
    ) {
      removedOrigins.push(key.replace('\0', ':'));
    }
  }
  removedOrigins.sort();
  counts.removed = removedOrigins.length;

  return {
    mounts: evidence,
    candidates: candidates.sort((a, b) => a.rawPath.localeCompare(b.rawPath)),
    counts,
    removedOrigins,
    staleMounts: evidence.filter((item) => item.stale).map((item) => item.name),
    missingMounts: evidence.filter((item) => item.missing).map((item) => item.name),
  };
}

function receiptScan(scan: MaintenanceScan): Omit<MaintenanceScan, 'candidates'> {
  return {
    mounts: scan.mounts,
    counts: scan.counts,
    removedOrigins: scan.removedOrigins,
    staleMounts: scan.staleMounts,
    missingMounts: scan.missingMounts,
  };
}

function receiptDirectory(workspacePath: string): string {
  return join(workspacePath, '.ico', 'maintenance');
}

export function writeMaintenanceReceipt(workspacePath: string, receipt: MaintenanceReceipt): void {
  const root = receiptDirectory(workspacePath);
  const history = join(root, 'receipts');
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const target of [join(history, `${receipt.runId}.json`), join(root, 'latest.json')]) {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, text, { encoding: 'utf-8', mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

export function readLatestMaintenanceReceipt(workspacePath: string): MaintenanceReceipt | null {
  try {
    return JSON.parse(
      readFileSync(join(receiptDirectory(workspacePath), 'latest.json'), 'utf-8'),
    ) as MaintenanceReceipt;
  } catch {
    return null;
  }
}

function atomicWriteCandidate(workspacePath: string, candidate: MaintenanceCandidate): void {
  if (!candidate.copyRequired) return;
  const target = join(workspacePath, candidate.rawPath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, candidate.bytes, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function finiteNonNegative(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function emptyAffected(): AffectedSet {
  return {
    changedSourcePaths: [],
    newSourcePaths: [],
    unchangedSourcePaths: [],
    affectedPages: [],
    conservativeSweep: false,
  };
}

function emptyReceiptScan(): Omit<MaintenanceScan, 'candidates'> {
  return {
    mounts: [],
    counts: {
      mounts: 0,
      files: 0,
      unchanged: 0,
      legacyUnchanged: 0,
      policyBlocked: 0,
      new: 0,
      changed: 0,
      pending: 0,
      removed: 0,
    },
    removedOrigins: [],
    staleMounts: [],
    missingMounts: [],
  };
}

function printReceipt(receipt: MaintenanceReceipt, json: boolean): void {
  if (json) {
    process.stdout.write(`${formatJSON(receipt)}\n`);
    return;
  }
  const counts = receipt.scan.counts;
  const summary =
    `${receipt.status}: ${counts.files} files, ${counts.new} new, ` +
    `${counts.changed} changed, ${counts.pending} pending, ` +
    `${counts.policyBlocked} policy-blocked, ${receipt.compilationRowsAdded} compilations added`;
  process.stdout.write(
    (receipt.status === 'failure' ? formatError(summary) : formatSuccess(summary)) + '\n',
  );
  process.stdout.write(
    formatInfo(`Receipt: ${join(receiptDirectory(receipt.workspace), 'latest.json')}`) + '\n',
  );
}

export async function runMaintenance(
  workspacePath: string,
  dbPath: string,
  opts: MaintainOptions,
): Promise<MaintenanceReceipt> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const maxInputAgeDays = finiteNonNegative(opts.maxInputAgeDays, 0, '--max-input-age-days');
  const dailyCeilingUsd = finiteNonNegative(opts.dailyCeilingUsd, 1, '--daily-ceiling-usd');
  const debounceSeconds = finiteNonNegative(opts.debounceSeconds, 300, '--debounce-seconds');
  const lockWaitSeconds = finiteNonNegative(opts.lockWaitSeconds, 10, '--lock-wait-seconds');
  let finalReceipt: MaintenanceReceipt | null = null;

  const lockResult = await withWriteLock(
    async () => {
      const dbResult = initDatabase(dbPath);
      if (!dbResult.ok) throw dbResult.error;
      const db = dbResult.value;
      try {
        let scan: MaintenanceScan;
        try {
          scan = scanMountedSources(db, workspacePath, { maxInputAgeDays });
        } catch (error) {
          finalReceipt = {
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            runId,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: 'failure',
            workspace: workspacePath,
            model: null,
            scan: emptyReceiptScan(),
            rawPaths: [],
            plannedAffectedTypes: [],
            compilationRowsAdded: 0,
            projectedCostUsd: null,
            errorCode: 'scan_failed',
            error: error instanceof Error ? error.message : String(error),
          };
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const base: Omit<MaintenanceReceipt, 'status' | 'finishedAt' | 'errorCode' | 'error'> = {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          runId,
          startedAt,
          workspace: workspacePath,
          model: null,
          scan: receiptScan(scan),
          rawPaths: scan.candidates.map((candidate) => candidate.rawPath),
          plannedAffectedTypes: [],
          compilationRowsAdded: 0,
          projectedCostUsd: null,
        };

        const fail = (errorCode: string, error: string): MaintenanceReceipt => ({
          ...base,
          finishedAt: new Date().toISOString(),
          status: 'failure',
          errorCode,
          error,
        });

        if (scan.counts.mounts === 0) {
          finalReceipt = fail('no_mounts', 'No source mounts are registered');
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.missingMounts.length > 0) {
          finalReceipt = fail('missing_mount', `Missing mounts: ${scan.missingMounts.join(', ')}`);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.staleMounts.length > 0) {
          finalReceipt = fail('stale_input', `Stale mounts: ${scan.staleMounts.join(', ')}`);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.removedOrigins.length > 0) {
          finalReceipt = fail(
            'removed_source_requires_retirement',
            `${scan.removedOrigins.length} mounted source(s) were removed; explicit retirement is required`,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        const previous = readLatestMaintenanceReceipt(workspacePath);
        const retryPaths =
          previous !== null && (previous.status === 'failure' || previous.status === 'running')
            ? previous.rawPaths.filter((path) => existsSync(join(workspacePath, path)))
            : [];
        const isRetry = retryPaths.length > 0;
        const candidatePaths = new Set(scan.candidates.map((candidate) => candidate.rawPath));
        const retryOnlyPaths = retryPaths.filter((path) => !candidatePaths.has(path));
        const changed: ChangedFile[] = scan.candidates.map((candidate) => ({
          path: candidate.rawPath,
          hash: candidate.hash,
        }));
        for (const path of retryOnlyPaths) {
          const bytes = readFileSync(join(workspacePath, path));
          changed.push({ path, hash: sha256(bytes) });
        }

        if (changed.length === 0) {
          const terminalReceipt: MaintenanceReceipt = {
            ...base,
            finishedAt: new Date().toISOString(),
            status: 'verified_noop',
            errorCode: null,
            error: null,
          };
          db.prepare('UPDATE mounts SET last_indexed_at = ?').run(terminalReceipt.finishedAt);
          writeMaintenanceReceipt(workspacePath, terminalReceipt);
          finalReceipt = terminalReceipt;
          return;
        }

        const affectedResult = computeAffectedSet(db, changed);
        if (!affectedResult.ok) {
          finalReceipt = fail('diff_failed', affectedResult.error.message);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const affected = affectedResult.value;
        const forcedPaths = [
          ...scan.candidates
            .filter((candidate) => candidate.kind === 'pending')
            .map((candidate) => candidate.rawPath),
          ...retryOnlyPaths,
        ];
        const plannedAffectedTypes =
          isRetry && previous?.plannedAffectedTypes.length
            ? previous.plannedAffectedTypes
            : affectedCostTypes(affected, forcedPaths.length);
        const retryNeedsCrossSource =
          isRetry &&
          (previous?.plannedAffectedTypes.some((type) =>
            ['topic', 'contradiction', 'open-question'].includes(type),
          ) ??
            false);
        base.plannedAffectedTypes = [...plannedAffectedTypes];
        base.rawPaths = Array.from(new Set(changed.map((item) => item.path))).sort();

        if (opts.scanOnly === true) {
          finalReceipt = fail(
            'scan_found_pending_work',
            `Scan-only run found ${changed.length} source path(s) requiring work`,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        let config: ReturnType<typeof loadConfig>;
        try {
          config = loadConfig(workspacePath);
        } catch (error) {
          finalReceipt = fail(
            'provider_config_failed',
            error instanceof Error ? error.message : String(error),
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const model = opts.model ?? config.model;
        base.model = model;
        const gate = evaluateCostGate(
          db,
          { affectedTypes: plannedAffectedTypes },
          {
            model,
            dailyCeilingUsd,
            debounceWindowSeconds: debounceSeconds,
          },
        );
        if (!gate.ok) {
          finalReceipt = fail('cost_gate_failed', gate.error.message);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        base.projectedCostUsd = gate.value.projectedCostUsd;
        if (gate.value.decision !== 'proceed') {
          finalReceipt = fail(`cost_${gate.value.decision}`, gate.value.reason);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        const running: MaintenanceReceipt = {
          ...base,
          finishedAt: null,
          status: 'running',
          errorCode: null,
          error: null,
        };
        writeMaintenanceReceipt(workspacePath, running);

        const before = db
          .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM compilations')
          .get();
        if (before === undefined) throw new Error('Could not count compilation rows before run');

        try {
          for (const candidate of scan.candidates) atomicWriteCandidate(workspacePath, candidate);

          const provenance = new Map<string, RawSourceProvenance>();
          for (const candidate of scan.candidates) {
            provenance.set(candidate.rawPath, {
              mountId: candidate.mountId,
              metadata: {
                maintenance: {
                  mountId: candidate.mountId,
                  mountName: candidate.mountName,
                  relativePath: candidate.relativePath,
                  originPath: candidate.originPath,
                },
              },
            });
          }
          const registrationAffected =
            affected.changedSourcePaths.length === 0 && affected.newSourcePaths.length === 0
              ? emptyAffected()
              : affected;
          registerChangedWorkspaceSources({ workspacePath, db }, changed, registrationAffected, {
            forcePaths: forcedPaths,
            provenanceByPath: provenance,
          });

          const client = createClaudeClient(config.apiKey);
          const ctx: CompileContext = { workspacePath, dbPath, db, client, model };
          await runAffectedPipelineUnlocked(ctx, affected, {
            forceSourceWork: forcedPaths.length > 0,
            // A retry may have registered the raw source before a later pass
            // failed, so today's diff can be empty. Resume only the pass classes
            // that the preceding, already-priced plan contained.
            forceCrossSource: retryNeedsCrossSource,
          });

          const after = db
            .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM compilations')
            .get();
          if (after === undefined) throw new Error('Could not count compilation rows after run');
          base.compilationRowsAdded = after.n - before.n;
          if (base.compilationRowsAdded <= 0) {
            throw new Error('Compiler returned without adding a compilation row');
          }

          const terminalReceipt: MaintenanceReceipt = {
            ...base,
            finishedAt: new Date().toISOString(),
            status: 'compiled',
            errorCode: null,
            error: null,
          };
          db.prepare('UPDATE mounts SET last_indexed_at = ?').run(terminalReceipt.finishedAt);
          writeMaintenanceReceipt(workspacePath, terminalReceipt);
          finalReceipt = terminalReceipt;
        } catch (error) {
          finalReceipt = fail(
            'compile_failed',
            error instanceof Error ? error.message : String(error),
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
        }
      } finally {
        closeDatabase(db);
      }
    },
    { waitSeconds: lockWaitSeconds, requireLock: true },
  );

  if (!lockResult.ok || !lockResult.value.ran) {
    const message = !lockResult.ok
      ? lockResult.error.message
      : 'Another brain writer held the lock for the full wait window';
    if (finalReceipt === null) {
      finalReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'failure',
        workspace: workspacePath,
        model: null,
        scan: emptyReceiptScan(),
        rawPaths: [],
        plannedAffectedTypes: [],
        compilationRowsAdded: 0,
        projectedCostUsd: null,
        errorCode: 'write_lock_unavailable',
        error: message,
      };
      writeMaintenanceReceipt(workspacePath, finalReceipt);
    }
  }

  if (finalReceipt === null) {
    throw new Error('Maintenance run completed without a terminal receipt');
  }
  return finalReceipt;
}

export function register(program: Command): void {
  program
    .command('maintain')
    .description('Scan mounted sources and run a receipted incremental compile')
    .option('--scan-only', 'Scan and write a receipt without ingesting or compiling')
    .option('--model <model>', 'Override the configured compiler model')
    .option('--daily-ceiling-usd <n>', 'Maximum projected UTC-day inference spend', '1')
    .option('--debounce-seconds <n>', 'Coalescing window for repeated triggers', '300')
    .option(
      '--max-input-age-days <n>',
      'Fail when any mount has no input newer than this; 0 disables',
      '0',
    )
    .option('--lock-wait-seconds <n>', 'Seconds to wait for the required brain write lock', '10')
    .addHelpText(
      'after',
      '\nOutcomes:\n  compiled       eligible deltas produced compilation rows\n  verified_noop content hashes prove there was no eligible work\n  failure        stale/missing input, pending retirement, budget, lock, or compiler failure',
    )
    .action(async (opts: MaintainOptions, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      const resolved = resolveWorkspace(
        global.workspace !== undefined ? { workspace: global.workspace } : undefined,
      );
      if (!resolved.ok) {
        process.stderr.write(`${formatError(resolved.error.message)}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const receipt = await runMaintenance(resolved.value.root, resolved.value.dbPath, opts);
        printReceipt(receipt, global.json === true);
        if (receipt.status === 'failure') process.exitCode = 1;
      } catch (error) {
        process.stderr.write(
          `${formatError(error instanceof Error ? error.message : String(error))}\n`,
        );
        process.exitCode = 1;
      }
    });
}
