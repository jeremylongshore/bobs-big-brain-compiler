// Workspace
export { initWorkspace, type WorkspaceInfo } from './workspace.js';

// Database
export { initDatabase, runMigrations, closeDatabase, type Database } from './state.js';

// Mounts
export { registerMount, listMounts, getMount, getMountByName, removeMount } from './mounts.js';

// Sources
export {
  registerSource,
  getSource,
  listSources,
  isSourceChanged,
  computeFileHash,
  type RegisterSourceParams,
} from './sources.js';

// Provenance
export {
  recordProvenance,
  getProvenance,
  getDerivations,
  type ProvenanceRecord,
} from './provenance.js';

// Traces
export { writeTrace, readTraces, type TraceRecord } from './traces.js';

// Tasks
export { createTask, transitionTask, getTask, listTasks, type TaskRecord } from './tasks.js';

// Archive
export { archiveTask, type ArchiveResult } from './archive.js';

// Recall
export {
  listRecallResults,
  recordRecallResult,
  type RecallResultRow,
  type RecordRecallInput,
} from './recall-results.js';

// Retention
export {
  getRetentionByConcept,
  getRetentionReport,
  getWeakAreas,
  type ConceptRetention,
  type RetentionReport,
  type WeakAreasOptions,
} from './retention.js';

// Wiki
export { rebuildWikiIndex } from './wiki-index.js';

// Audit
export { appendAuditLog } from './audit-log.js';

// Search
export {
  createSearchIndex,
  indexCompiledPages,
  searchPages,
  findRelevantPages,
  type SearchResult,
  type QuestionType,
} from './search.js';

// Promotion
export {
  promoteArtifact,
  PromotionError,
  VALID_PROMOTION_TYPES,
  type PromotionErrorCode,
  type PromotionInput,
  type PromotionResult,
  type PromotionType,
} from './promotion.js';

// Post-promotion
export {
  runPostPromotionRefresh,
  type LintIssue,
  type PostPromotionResult,
} from './post-promote.js';

// Unpromote
export {
  unpromoteArtifact,
  UnpromoteError,
  type UnpromoteErrorCode,
  type UnpromoteInput,
  type UnpromoteResult,
} from './unpromote.js';

// Artifacts
export { listArtifacts, type ArtifactInfo } from './artifacts.js';

// Spool — ICO → INTKB writer-side boundary
export {
  emitSpool,
  dryRunSpool,
  SpoolError,
  type SpoolEmitOptions,
  type SpoolEmitResult,
  type SpoolEmitScope,
  type SpoolSkipReason,
  type SpoolDryRunSummary,
} from './spool.js';

// UUID v5: canonical content-derived candidate-ID derivation (ICO <-> INTKB
// byte-identical contract). See `./uuid.ts`.
export { uuidV5, spoolCandidateName, deriveSpoolCandidateId } from './uuid.js';

// Audit-chain verifier
export { verifyAuditChain, type AuditChainBreak, type AuditVerifyResult } from './audit-verify.js';

// Workspace reconciler — receipts-precede-visibility floor (quarantine, never delete)
export {
  reconcileWorkspace,
  type ReconcileEntry,
  type ReconcileOptions,
  type ReconcileResult,
} from './reconcile.js';

// NOTE: the test-only crash hook (./crash-hook.js) is deliberately NOT
// re-exported here — kernel writers import it directly so the fault
// injector never becomes public API surface.

// Disclosure guard — no-comp/no-PII choke at the brain boundary (ico ingest)
export {
  scanForDisclosure,
  disclosureLabel,
  type DisclosureCategory,
  type DisclosureViolation,
} from './disclosure.js';

// Procfs — computed views over task state
export {
  computeTaskStatus,
  renderTaskStatusMarkdown,
  computeMemoryMap,
  renderMemoryMapMarkdown,
  materializeStatus,
  type TaskStatusView,
  type MemoryMapSection,
} from './procfs.js';

// Brain single-writer lock — serialises ~/.teamkb writers (nightly compile,
// on-push incremental compile, backup) under the e06.12 flock. See `./write-lock.ts`.
export {
  withWriteLock,
  resolveLockPath,
  type WriteLockOptions,
  type WriteLockResult,
} from './write-lock.js';

// Configuration
export { loadConfig, redactSecrets, type IcoConfig } from './config.js';
export { Logger, createLogger } from './logger.js';
export { version } from './version.js';

// Evals (Epic 10)
export {
  discoverEvalSpecs,
  loadAllEvalSpecs,
  loadEvalSpec,
  runEval,
  runEvals,
  type BaseEvalSpec,
  type CitationEvalSpec,
  type CompilationEvalSpec,
  type EvalBatchResult,
  type EvalResult,
  type EvalSpec,
  type EvalType,
  type FaithfulnessEvalSpec,
  type RetrievalEvalSpec,
  type RunEvalOptions,
  type SmokeEvalSpec,
} from './evals/index.js';

// Faithfulness provenance-sampling (e06.8) — deterministic, pure-kernel.
export {
  getCompilationSources,
  sampleCompilationsForFaithfulness,
  type FaithfulnessSampleItem,
  type FaithfulnessSampleOptions,
  type FaithfulnessSource,
} from './evals/faithfulness-provenance.js';

// Faithfulness token-meter recorder (e06.8) — the eval's ONLY durable write.
export { recordFaithfulnessTokens } from './evals/faithfulness-tokens.js';
