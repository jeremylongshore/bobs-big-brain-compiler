/**
 * `ico maintain` — scan registered mounts, ingest eligible deltas, and compile
 * them under one governed write lock.
 *
 * This is intentionally separate from the agent-driven knowledge distiller.
 * A maintenance receipt makes a mounted-source freshness claim and can say
 * `compiled`, `partial`, `verified_noop`, or `failure`; a clean process exit is
 * never used as a proxy for useful work.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
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
  calculateCost,
  type ChangedFile,
  type ClaudeClient,
  type CompletionOptions,
  type CompletionResult,
  computeAffectedSet,
  createClaudeClient,
  evaluateCostGate,
  resolvePricingModel,
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
import { err, type Mount, type Result, type Source } from '@ico/types';

import { formatError, formatInfo, formatJSON, formatSuccess } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';
import {
  type CompileContext,
  type RawSourceProvenance,
  registerChangedWorkspaceSources,
  runAffectedPipelineUnlocked,
  summaryPathsForSources,
} from './compile.js';
import { scanDirectory } from './ingest.js';

const RECEIPT_SCHEMA_VERSION = 2;
const INFERENCE_BUDGET_EXCEEDED = 'INFERENCE_BUDGET_EXCEEDED';

export type MaintenanceStatus = 'compiled' | 'partial' | 'verified_noop' | 'failure';
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
    governedExcluded: number;
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
  compileScope: 'mounted-source';
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
  progress: {
    eligible: number;
    selected: number;
    processed: number;
    governedExcluded: number;
    failed: number;
    remaining: number;
  };
  inference: {
    operations: number;
    inputTokens: number;
    outputTokens: number;
    actualCostUsd: number;
    spentTodayBeforeUsd: number;
    spentTodayAfterUsd: number;
    dailyCeilingUsd: number;
  };
  errorCode: string | null;
  error: string | null;
}

interface MaintenanceOrigin {
  mountId: string;
  mountName?: unknown;
  relativePath: string;
  originPath?: unknown;
  completedHash?: unknown;
  excludedReason?: unknown;
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
  maxCandidates?: string;
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
      ...(value['completedHash'] !== undefined && { completedHash: value['completedHash'] }),
      ...(value['excludedReason'] !== undefined && { excludedReason: value['excludedReason'] }),
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
    governedExcluded: 0,
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
        const origin = parseOrigin(tracked);
        if (tracked.hash === hash && origin?.completedHash === hash) {
          if (typeof origin.excludedReason === 'string') {
            counts.governedExcluded++;
            continue;
          }
          if (compiledSourceIds.has(tracked.id)) {
            counts.unchanged++;
            continue;
          }
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
  // mkdir's mode is creation-only. Repair an existing directory on every run
  // so a previously loose umask/manual creation cannot leave receipts exposed.
  chmodSync(root, 0o700);
  chmodSync(history, 0o700);
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

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  const value = finiteNonNegative(raw, fallback, label);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got "${raw ?? String(fallback)}"`);
  }
  return value;
}

interface MeterState {
  operations: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
}

interface MeteredClientOptions {
  db: Database;
  runId: string;
  model: string;
  dailyCeilingUsd: number;
  spentTodayBeforeUsd: number;
  operationType: () => string;
}

/** Wrap a provider client with a one-row-per-call durable usage ledger and hard runtime ceiling. */
export function createMeteredMaintenanceClient(
  client: ClaudeClient,
  options: MeteredClientOptions,
): { client: ClaudeClient; state: MeterState } {
  const state: MeterState = {
    operations: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
  };

  const metered: ClaudeClient = {
    async createCompletion(
      systemPrompt: string,
      userPrompt: string,
      completionOptions?: CompletionOptions,
    ): Promise<Result<CompletionResult, Error>> {
      const requestedModel = completionOptions?.model ?? options.model;
      const maxOutputTokens = completionOptions?.maxTokens ?? 4096;
      // UTF-8 bytes + a fixed protocol allowance is a deliberately conservative
      // upper bound for provider input tokens. Refuse before a call whose worst
      // case could cross the operator's ceiling; actual usage replaces it after.
      const maxInputTokens = Buffer.byteLength(systemPrompt) + Buffer.byteLength(userPrompt) + 1024;
      const worstCaseCost = calculateCost(
        maxInputTokens,
        maxOutputTokens,
        resolvePricingModel(requestedModel),
      );
      if (
        options.spentTodayBeforeUsd + state.actualCostUsd + worstCaseCost >
        options.dailyCeilingUsd
      ) {
        return err(
          new Error(
            `[${INFERENCE_BUDGET_EXCEEDED}] next ${options.operationType()} call could raise ` +
              `the UTC-day total above $${options.dailyCeilingUsd.toFixed(2)}`,
          ),
        );
      }

      const result = await client.createCompletion(systemPrompt, userPrompt, completionOptions);
      if (!result.ok) return result;

      const sequence = state.operations + 1;
      const occurredAt = new Date().toISOString();
      try {
        options.db
          .prepare(
            `INSERT INTO inference_operations
               (id, run_id, operation_sequence, operation_type, occurred_at,
                model, input_tokens, output_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            options.runId,
            sequence,
            options.operationType(),
            occurredAt,
            result.value.model,
            result.value.inputTokens,
            result.value.outputTokens,
          );
      } catch (error) {
        return err(
          new Error(
            `Provider call succeeded but its usage receipt could not be recorded: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }

      state.operations = sequence;
      state.inputTokens += result.value.inputTokens;
      state.outputTokens += result.value.outputTokens;
      state.actualCostUsd += calculateCost(
        result.value.inputTokens,
        result.value.outputTokens,
        resolvePricingModel(result.value.model),
      );
      return result;
    },
  };
  return { client: metered, state };
}

function maintenanceOperationTypes(candidateCount: number): string[] {
  // summarizeSource may make one validation-repair retry. Price that
  // documented maximum up front; the operation ledger records only the calls
  // actually made, so the day-spend receipt remains exact.
  return Array<string>(candidateCount * 2).fill('summary');
}

function markMaintenanceComplete(
  db: Database,
  candidate: MaintenanceCandidate,
  completedAt: string,
  excludedReason?: string,
): void {
  const row = db
    .prepare<[string, string], { id: string; metadata: string | null }>(
      `SELECT id, metadata FROM sources
        WHERE path = ? AND hash = ?
        ORDER BY ingested_at DESC LIMIT 1`,
    )
    .get(candidate.rawPath, candidate.hash);
  if (row === undefined) {
    throw new Error(`Completed maintenance source is not registered: ${candidate.rawPath}`);
  }
  let metadata: Record<string, unknown> = {};
  if (row.metadata !== null) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  const existing =
    typeof metadata['maintenance'] === 'object' && metadata['maintenance'] !== null
      ? (metadata['maintenance'] as Record<string, unknown>)
      : {};
  metadata['maintenance'] = {
    ...existing,
    mountId: candidate.mountId,
    mountName: candidate.mountName,
    relativePath: candidate.relativePath,
    originPath: candidate.originPath,
    completedHash: candidate.hash,
    completedAt,
    ...(excludedReason === undefined ? {} : { excludedReason }),
  };
  db.prepare('UPDATE sources SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), row.id);
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
      governedExcluded: 0,
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
    `${counts.policyBlocked} policy-blocked, ${receipt.progress.processed} processed, ` +
    `${receipt.progress.remaining} remaining, ${receipt.compilationRowsAdded} compilations added`;
  process.stdout.write(
    (receipt.status === 'failure' ? formatError(summary) : formatSuccess(summary)) + '\n',
  );
  process.stdout.write(
    formatInfo(`Receipt: ${join(receiptDirectory(receipt.workspace), 'latest.json')}`) + '\n',
  );
}

function emptyProgress(eligible = 0, selected = 0): MaintenanceReceipt['progress'] {
  return {
    eligible,
    selected,
    processed: 0,
    governedExcluded: 0,
    failed: 0,
    remaining: eligible,
  };
}

function emptyInference(dailyCeilingUsd: number): MaintenanceReceipt['inference'] {
  return {
    operations: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
    spentTodayBeforeUsd: 0,
    spentTodayAfterUsd: 0,
    dailyCeilingUsd,
  };
}

interface MaintenanceDependencies {
  createClient?: (apiKey: string) => ClaudeClient;
}

export async function runMaintenance(
  workspacePath: string,
  dbPath: string,
  opts: MaintainOptions,
  dependencies: MaintenanceDependencies = {},
): Promise<MaintenanceReceipt> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const maxInputAgeDays = finiteNonNegative(opts.maxInputAgeDays, 0, '--max-input-age-days');
  const dailyCeilingUsd = finiteNonNegative(opts.dailyCeilingUsd, 1, '--daily-ceiling-usd');
  const debounceSeconds = finiteNonNegative(opts.debounceSeconds, 300, '--debounce-seconds');
  const lockWaitSeconds = finiteNonNegative(opts.lockWaitSeconds, 10, '--lock-wait-seconds');
  const maxCandidates = positiveInteger(opts.maxCandidates, 10, '--max-candidates');
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
            compileScope: 'mounted-source',
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
            progress: emptyProgress(),
            inference: emptyInference(dailyCeilingUsd),
            errorCode: 'scan_failed',
            error: error instanceof Error ? error.message : String(error),
          };
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const previous = readLatestMaintenanceReceipt(workspacePath);
        const retryOrder = new Map(
          (previous?.status === 'failure' || previous?.status === 'running'
            ? previous.rawPaths
            : []
          ).map((path, index) => [path, index]),
        );
        const orderedCandidates = [...scan.candidates].sort((a, b) => {
          const aRetry = retryOrder.get(a.rawPath);
          const bRetry = retryOrder.get(b.rawPath);
          if (aRetry !== undefined || bRetry !== undefined) {
            if (aRetry === undefined) return 1;
            if (bRetry === undefined) return -1;
            return aRetry - bRetry;
          }
          return a.rawPath.localeCompare(b.rawPath);
        });
        const selectedCandidates =
          opts.scanOnly === true ? orderedCandidates : orderedCandidates.slice(0, maxCandidates);

        const base: Omit<MaintenanceReceipt, 'status' | 'finishedAt' | 'errorCode' | 'error'> = {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          compileScope: 'mounted-source',
          runId,
          startedAt,
          workspace: workspacePath,
          model: null,
          scan: receiptScan(scan),
          rawPaths: selectedCandidates.map((candidate) => candidate.rawPath),
          plannedAffectedTypes: [],
          compilationRowsAdded: 0,
          projectedCostUsd: null,
          progress: emptyProgress(scan.candidates.length, selectedCandidates.length),
          inference: emptyInference(dailyCeilingUsd),
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

        const changed: ChangedFile[] = selectedCandidates.map((candidate) => ({
          path: candidate.rawPath,
          hash: candidate.hash,
        }));

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
        // A prior run can fail after writing valid, receipted summaries (for
        // example the historical aggregate extract step timed out). Resume from
        // those durable per-source checkpoints instead of paying to summarize
        // the same hash again. The completion marker is written only below,
        // after the current run has verified the summary still resolves.
        const compileCandidates = selectedCandidates.filter(
          (candidate) => summaryPathsForSources(db, [candidate.rawPath]).length === 0,
        );
        const forcedPaths = compileCandidates
          .filter((candidate) => candidate.kind === 'pending')
          .map((candidate) => candidate.rawPath);
        // Scheduled maintenance makes one narrow, machine-checkable freshness
        // claim: every mounted source hash has a summary or an explicit
        // governed exclusion. Concept extraction is deliberately outside this
        // checkpoint: it aggregates summaries, so one provider timeout would
        // otherwise discard honest per-source progress for an entire batch.
        // Operators run `ico compile concepts` / `ico compile all` explicitly
        // under their own cost decision and evidence.
        const plannedAffectedTypes = maintenanceOperationTypes(compileCandidates.length);
        base.plannedAffectedTypes = [...plannedAffectedTypes];

        if (opts.scanOnly === true) {
          finalReceipt = fail(
            'scan_found_pending_work',
            `Scan-only run found ${scan.candidates.length} source path(s) requiring work`,
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
        base.inference.spentTodayBeforeUsd = gate.value.spentTodayUsd;
        base.inference.spentTodayAfterUsd = gate.value.spentTodayUsd;
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

        let meter: ReturnType<typeof createMeteredMaintenanceClient> | null = null;
        try {
          for (const candidate of selectedCandidates)
            atomicWriteCandidate(workspacePath, candidate);

          const provenance = new Map<string, RawSourceProvenance>();
          for (const candidate of selectedCandidates) {
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

          let operationType = 'unknown';
          meter = createMeteredMaintenanceClient(
            (dependencies.createClient ?? createClaudeClient)(config.apiKey),
            {
              db,
              runId,
              model,
              dailyCeilingUsd,
              spentTodayBeforeUsd: gate.value.spentTodayUsd,
              operationType: () => operationType,
            },
          );
          const ctx: CompileContext = { workspacePath, dbPath, db, client: meter.client, model };
          const pipeline = await runAffectedPipelineUnlocked(ctx, affected, {
            forceSourceWork: forcedPaths.length > 0,
            // Keep this scheduler independently checkpointable per source.
            suppressExtract: true,
            suppressCrossSource: true,
            sourcePaths: compileCandidates.map((candidate) => candidate.rawPath),
            onPassStart: (type) => {
              operationType = type;
            },
          });

          const after = db
            .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM compilations')
            .get();
          if (after === undefined) throw new Error('Could not count compilation rows after run');
          base.compilationRowsAdded = after.n - before.n;

          const skipped = new Set(pipeline.summary.skippedPaths);
          const completedAt = new Date().toISOString();
          const completed: MaintenanceCandidate[] = [];
          const failed: MaintenanceCandidate[] = [];
          for (const candidate of selectedCandidates) {
            const hasSummary = summaryPathsForSources(db, [candidate.rawPath]).length > 0;
            if (hasSummary || skipped.has(candidate.rawPath)) {
              markMaintenanceComplete(
                db,
                candidate,
                completedAt,
                skipped.has(candidate.rawPath) ? 'compile_validation' : undefined,
              );
              completed.push(candidate);
            } else {
              failed.push(candidate);
            }
          }

          base.progress.processed = completed.length;
          base.progress.governedExcluded = completed.filter((candidate) =>
            skipped.has(candidate.rawPath),
          ).length;
          base.progress.failed = failed.length;
          base.progress.remaining = scan.candidates.length - completed.length;
          base.inference = {
            operations: meter.state.operations,
            inputTokens: meter.state.inputTokens,
            outputTokens: meter.state.outputTokens,
            actualCostUsd: meter.state.actualCostUsd,
            spentTodayBeforeUsd: gate.value.spentTodayUsd,
            spentTodayAfterUsd: gate.value.spentTodayUsd + meter.state.actualCostUsd,
            dailyCeilingUsd,
          };

          if (failed.length > 0) {
            finalReceipt = fail(
              'source_compile_failed',
              `${failed.length} selected source(s) did not reach a summary or governed exclusion`,
            );
            writeMaintenanceReceipt(workspacePath, finalReceipt);
            return;
          }

          const terminalReceipt: MaintenanceReceipt = {
            ...base,
            finishedAt: completedAt,
            status: base.progress.remaining > 0 ? 'partial' : 'compiled',
            errorCode: null,
            error: null,
          };
          if (terminalReceipt.status === 'compiled') {
            db.prepare('UPDATE mounts SET last_indexed_at = ?').run(terminalReceipt.finishedAt);
          }
          writeMaintenanceReceipt(workspacePath, terminalReceipt);
          finalReceipt = terminalReceipt;
        } catch (error) {
          if (meter !== null) {
            base.inference = {
              operations: meter.state.operations,
              inputTokens: meter.state.inputTokens,
              outputTokens: meter.state.outputTokens,
              actualCostUsd: meter.state.actualCostUsd,
              spentTodayBeforeUsd: base.inference.spentTodayBeforeUsd,
              spentTodayAfterUsd: base.inference.spentTodayBeforeUsd + meter.state.actualCostUsd,
              dailyCeilingUsd,
            };
          }
          const message = error instanceof Error ? error.message : String(error);
          finalReceipt = fail(
            message.includes(INFERENCE_BUDGET_EXCEEDED) ? 'cost_runtime_defer' : 'compile_failed',
            message,
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
        compileScope: 'mounted-source',
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
        progress: emptyProgress(),
        inference: emptyInference(dailyCeilingUsd),
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
    .option('--max-candidates <n>', 'Maximum mounted source candidates processed per run', '10')
    .addHelpText(
      'after',
      '\nOutcomes:\n  compiled       every eligible delta reached a compiled or governed outcome\n  partial        the bounded batch advanced, with remaining work receipted\n  verified_noop content hashes prove there was no eligible work\n  failure        stale/missing input, pending retirement, budget, lock, or compiler failure',
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
