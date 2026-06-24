export { version } from './version.js';
export { detectSourceType, ingestSource, type SourceType } from './adapters/registry.js';
export type { IngestResult, IngestMetadata } from './adapters/types.js';
export {
  runIngestPipeline,
  type IngestPipelineOptions,
  type IngestPipelineResult,
} from './ingest-pipeline.js';
export { validateCompiledPage, validateFrontmatter, type ValidationResult } from './validation.js';
export {
  detectStalePages,
  markStale,
  getUncompiledSources,
  type StalePageInfo,
} from './staleness.js';
export {
  detectOrphans,
  extractWikilinks,
  type LintResult,
  runLint,
  scanWikiPages,
  type SchemaError,
} from './lint.js';
export {
  createClaudeClient,
  estimateTokens,
  sanitizeForPrompt,
  type ClaudeClient,
  type CompletionOptions,
  type CompletionResult,
} from './api/claude-client.js';
export {
  resolveProvider,
  resolveApiKey,
  resolveModel,
  providerRequiresKey,
  listBuiltinProviders,
  type ProviderConfig,
  type WireFormat,
} from '@ico/types';
export {
  calculateCost,
  getTokenUsageSummary,
  formatTokenUsage,
  type TokenUsageSummary,
  type ModelPricing,
  MODEL_PRICING,
} from './token-tracker.js';
export {
  summarizeSource,
  type SummarizeOptions,
  type SummarizeResult,
} from './passes/summarize.js';
export { extractConcepts, type ExtractOptions, type ExtractResult } from './passes/extract.js';
export {
  chunkArray,
  DEFAULT_BATCH_SIZE,
  deriveStableId,
  mergePages,
  normalizeTitle,
  type MergedPage,
  type MergePagesOptions,
} from './passes/batch-helper.js';
export {
  synthesizeTopics,
  type SynthesizeOptions,
  type SynthesizeResult,
} from './passes/synthesize.js';
export { addBacklinks, type LinkOptions, type LinkResult } from './passes/link.js';
export {
  detectContradictions,
  type ContradictOptions,
  type ContradictResult,
} from './passes/contradict.js';
export { identifyGaps, type GapOptions, type GapResult } from './passes/gap.js';
export { analyzeQuestion, type QuestionAnalysis, type QuestionType } from './ask/analyze.js';
export { generateAnswer, type GeneratedAnswer, type Citation } from './ask/generate.js';
export { verifyCitations, type VerificationResult, type ProvenanceEntry } from './ask/verify.js';
export {
  renderReport,
  slugify as slugifyReport,
  type RenderReportOptions,
  type RenderReportResult,
  type ReportSource,
} from './render/report.js';
export {
  renderSlides,
  slugifyTitle as slugifySlides,
  type RenderSlidesOptions,
  type RenderSlidesResult,
  type SlideSource,
} from './render/slides.js';
export {
  validateArtifact,
  validateAllArtifacts,
  type ArtifactFrontmatter,
  type ArtifactValidation,
} from './render/artifact-meta.js';
export {
  gatherTaskOutput,
  type TaskOutput,
  type TaskOutputSource,
} from './render/task-renderer.js';
export {
  collectEvidence,
  type CollectorOptions,
  type CollectorResult,
  type EvidenceFile,
} from './agents/collector.js';
export {
  summarizeEvidence,
  type EvidenceSource,
  type SummarizerOptions,
  type SummarizerResult,
} from './agents/summarizer.js';
export { critiqueFindings, type SkepticOptions, type SkepticResult } from './agents/skeptic.js';
export {
  integrateFindings,
  type IntegratorOptions,
  type IntegratorResult,
} from './agents/integrator.js';
export {
  executeResearch,
  type OrchestratorOptions,
  type OrchestratorOutcome,
  type OrchestratorPausedResult,
  type OrchestratorResult,
  type Stage,
  type StepConfirmation,
} from './agents/orchestrator.js';
export {
  generateRecall,
  slugify as slugifyRecall,
  type CardFile,
  type QuizFile,
  type RecallGenerateOptions,
  type RecallGenerateResult,
} from './recall/generate.js';
export {
  parseQuizFile,
  runQuiz,
  type QuizMode,
  type QuizOptions,
  type QuizQuestion,
  type QuizResult,
  type QuizSummary,
} from './recall/quiz.js';
export {
  exportRecallAnki,
  type AnkiCard,
  type ExportAnkiOptions,
  type ExportAnkiResult,
} from './recall/export.js';
export { runCompilationEval, type CompilationEvalOptions } from './evals/compilation.js';
