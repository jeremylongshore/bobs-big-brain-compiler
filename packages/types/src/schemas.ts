import { z } from 'zod';

// --- Source (L1 Raw Corpus) ---

export const SourceSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  type: z.enum(['pdf', 'markdown', 'html', 'text']),
  title: z.string().nullable(),
  author: z.string().nullable(),
  ingested_at: z.string().datetime(),
  word_count: z.number().int().nonnegative().nullable(),
  hash: z.string(),
  metadata: z.string().nullable(),
});

export type Source = z.infer<typeof SourceSchema>;

// --- Mount ---

export const MountSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  created_at: z.string().datetime(),
  last_indexed_at: z.string().datetime().nullable(),
});

export type Mount = z.infer<typeof MountSchema>;

// --- Compilation (L2 Semantic Knowledge) ---

export const CompilationSchema = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid().nullable(),
  type: z.enum(['summary', 'concept', 'topic', 'entity', 'contradiction', 'open-question']),
  output_path: z.string(),
  compiled_at: z.string().datetime(),
  model: z.string(),
  tokens_used: z.number().int().nonnegative().nullable(),
});

export type Compilation = z.infer<typeof CompilationSchema>;

// --- Task (L3 Episodic Tasks) ---

export const TaskStatusSchema = z.enum([
  'created',
  'collecting',
  'synthesizing',
  'critiquing',
  'rendering',
  'completed',
  'archived',
  // Recoverable failure states (E9-B06). Emitted by the research orchestrator
  // when an agent returns err(...) during its stage. Each failure state has a
  // single recovery transition back to the state that preceded the failed
  // stage, so an operator (or a later `ico research --retry`) can re-run just
  // that stage without losing work from earlier stages.
  'failed_collecting',
  'failed_synthesizing',
  'failed_critiquing',
  'failed_rendering',
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  brief: z.string(),
  status: TaskStatusSchema,
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  workspace_path: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

// --- Promotion (L2 ← L4) ---

export const PromotionSchema = z.object({
  id: z.string().uuid(),
  source_path: z.string(),
  target_path: z.string(),
  target_type: z.enum(['topic', 'concept', 'entity', 'reference']),
  promoted_at: z.string().datetime(),
  promoted_by: z.enum(['user']),
  source_hash: z.string(),
});

export type Promotion = z.infer<typeof PromotionSchema>;

// --- Recall Results (L5) ---

export const RecallResultSchema = z.object({
  id: z.string().uuid(),
  concept: z.string(),
  correct: z.boolean(),
  tested_at: z.string().datetime(),
  confidence: z.number().min(0).max(1).nullable(),
});

export type RecallResult = z.infer<typeof RecallResultSchema>;

// --- Trace Events (L6 Audit) ---

export const TraceEnvelopeSchema = z.object({
  timestamp: z.string().datetime(),
  event_type: z.string(),
  event_id: z.string().uuid(),
  correlation_id: z.string().uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  prev_hash: z.string().nullable(),
});

export type TraceEnvelope = z.infer<typeof TraceEnvelopeSchema>;
export type TraceEvent = TraceEnvelope;
