/**
 * Research orchestrator for episodic tasks (E9-B06).
 *
 * `executeResearch()` is the glue that drives a research task through the
 * full four-stage agent pipeline and into the L3→L4 render hand-off:
 *
 *   Collector → Summarizer → Skeptic → Integrator → renderReport
 *
 * Resumption: the starting stage is derived from the task's current status,
 * so `executeResearch()` can be re-invoked on a partially-completed task to
 * pick up from wherever it left off. This also means `--step` mode works by
 * running one stage per invocation (or by awaiting `confirmStep` between
 * stages inside a single invocation; callers pick whichever suits them).
 *
 * Failure handling: if an agent returns `err(...)`, the orchestrator
 * transitions the task to a recoverable `failed_<stage>` state (e.g.
 * `failed_critiquing`) and returns `err(...)`. The task is *never* left in
 * an ambiguous state where the operator cannot tell whether the current
 * stage ran. Passing `retry: true` to a later invocation rolls a
 * `failed_*` task back to its predecessor state so the next invocation
 * re-runs just the failed stage.
 *
 * Budget: `maxTokens` caps cumulative Claude usage across every stage that
 * calls the API. When a stage pushes the running total past the budget the
 * orchestrator records the overage in the trace, transitions the task to
 * the matching `failed_<stage>` state, and returns `err(...)`.
 *
 * L3→L4 hand-off: after the Integrator produces `output/final.md` and the
 * task reaches `rendering`, the orchestrator invokes `renderReport` from
 * the Epic 8 render pipeline to write a markdown report to
 * `workspace/outputs/reports/`. Only after that write succeeds is the task
 * transitioned to `completed`. The Integrator itself never copies to L4.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module agents/orchestrator
 */

import {
  appendAuditLog,
  type Database,
  getTask,
  type TaskRecord,
  transitionTask,
  writeTrace,
} from '@ico/kernel';
import { err, ok, type Result, type TaskStatus } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { renderReport } from '../render/report.js';
import { gatherTaskOutput } from '../render/task-renderer.js';
import { collectEvidence } from './collector.js';
import { integrateFindings } from './integrator.js';
import { critiqueFindings } from './skeptic.js';
import { summarizeEvidence } from './summarizer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Logical pipeline stages. */
export type Stage = 'collect' | 'summarize' | 'critique' | 'integrate' | 'render';

/**
 * Hook invoked between stages when `step: true` is set. The orchestrator
 * awaits the returned promise and aborts if it resolves to `false`.
 *
 * `fromStatus` is the status the task is in right now (just after the
 * previous stage completed); `nextStage` is the stage about to run.
 */
export type StepConfirmation = (args: {
  fromStatus: TaskStatus;
  nextStage: Stage;
  tokensUsed: number;
  budget: number;
}) => Promise<boolean>;

/** Options controlling a single orchestrator invocation. */
export interface OrchestratorOptions {
  /** Claude client injected so tests can mock. Required. */
  client: ClaudeClient;
  /**
   * When true, await `confirmStep` before advancing past any stage that
   * still has work remaining. When no `confirmStep` hook is supplied the
   * orchestrator treats each stage boundary as an abort, running exactly
   * one stage per invocation — the shape expected by `ico research --step`.
   */
  step?: boolean;
  /** Confirmation hook used when `step: true`. */
  confirmStep?: StepConfirmation;
  /**
   * Hard cap on cumulative Claude tokens (input + output, summed across
   * every Claude-calling stage). Defaults to the `ICO_MAX_RESEARCH_TOKENS`
   * env var, or 200_000 when unset.
   */
  maxTokens?: number;
  /** Per-stage model overrides. Falls back to each agent's default. */
  models?: {
    summarizer?: string;
    skeptic?: string;
    integrator?: string;
    report?: string;
  };
  /**
   * When the task is in a `failed_*` state, first roll it back to the
   * state that preceded the failed stage, then resume from there. When
   * false (the default) the orchestrator refuses to act on a failed task
   * so the operator must explicitly opt in to rework.
   */
  retry?: boolean;
}

/** Successful execution result. */
export interface OrchestratorResult {
  taskId: string;
  /** Final task status. Always `'completed'` on success. */
  finalStatus: 'completed';
  /** Total Claude tokens consumed across every stage. */
  tokensUsed: number;
  /** Per-stage Claude token breakdown. Collector is always 0. */
  stageTokens: Record<Stage, number>;
  /** Workspace-relative path of the rendered report (L4 artifact). */
  reportPath: string;
  /** Workspace-relative path of the final integrator output (L3 artifact). */
  finalOutputPath: string;
  /** Stages that actually ran this invocation (resume-aware). */
  stagesRun: Stage[];
}

/** Intermediate result returned when `step: true` pauses after a stage. */
export interface OrchestratorPausedResult {
  taskId: string;
  /** The task status right now — always the state just written by `lastStage`. */
  currentStatus: TaskStatus;
  /** Stages completed so far in this invocation. */
  stagesRun: Stage[];
  /** Cumulative tokens used so far. */
  tokensUsed: number;
  /** Per-stage tokens. Unrun stages are 0. */
  stageTokens: Record<Stage, number>;
  /** Reason the orchestrator paused. */
  reason: 'step' | 'operator_aborted';
}

/** Successful orchestrator return shape. */
export type OrchestratorOutcome = OrchestratorResult | OrchestratorPausedResult;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = 200_000;

/**
 * Maps each forward-progress status to the next stage to run. Terminal
 * states (`completed`, `archived`) and failure states have their own
 * handling before this table is consulted.
 */
const NEXT_STAGE: Record<string, Stage | null> = {
  created: 'collect',
  collecting: 'summarize',
  synthesizing: 'critique',
  critiquing: 'integrate',
  rendering: 'render',
  completed: null,
  archived: null,
};

/** Failure state the orchestrator writes when each stage returns err(...). */
const FAILURE_STATE: Record<Stage, TaskStatus> = {
  collect: 'failed_collecting',
  summarize: 'failed_synthesizing',
  critique: 'failed_critiquing',
  integrate: 'failed_rendering',
  render: 'failed_rendering',
};

/**
 * For each `failed_*` state, the predecessor status to roll back to when
 * `retry: true`. The agent for the failed stage runs from that state.
 */
const FAILURE_ROLLBACK: Partial<Record<TaskStatus, TaskStatus>> = {
  failed_collecting: 'created',
  failed_synthesizing: 'collecting',
  failed_critiquing: 'synthesizing',
  failed_rendering: 'critiquing',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStageTokens(): Record<Stage, number> {
  return { collect: 0, summarize: 0, critique: 0, integrate: 0, render: 0 };
}

/**
 * Resolve budget from options, env, or default. Returns a positive integer.
 */
function resolveBudget(maxTokens: number | undefined): number {
  if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.floor(maxTokens);
  }
  const fromEnv = process.env['ICO_MAX_RESEARCH_TOKENS'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BUDGET;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Drive a research task through the four-agent pipeline and the L3→L4
 * render hand-off.
 *
 * Behaviour summary:
 * 1. Loads the task. If `retry: true` and the task is in a `failed_*`
 *    state, rolls back to the predecessor state first.
 * 2. Derives the starting stage from the current status. Tasks already
 *    `completed` or `archived` return ok immediately with an empty run.
 * 3. For each stage from the starting point through `render`:
 *    a. Emits an `orchestrator.stage_start` trace.
 *    b. Runs the stage (collector / summarizer / skeptic / integrator /
 *       renderReport). The stage itself owns the forward state transition
 *       on success.
 *    c. On stage failure: writes an `orchestrator.abort` trace,
 *       transitions the task to `failed_<stage>`, returns err.
 *    d. Accumulates Claude tokens. If the cumulative total exceeds the
 *       budget, aborts the same way.
 *    e. Emits `orchestrator.stage_complete` with cumulative usage.
 *    f. When `step: true`, awaits `confirmStep` (or aborts if none is
 *       supplied). `false` → returns an `OrchestratorPausedResult` with
 *       `reason: 'operator_aborted'`; no further stages run.
 * 4. After the render stage, transitions `rendering` → `completed`.
 *
 * Never throws.
 */
export async function executeResearch(
  db: Database,
  workspacePath: string,
  taskId: string,
  options: OrchestratorOptions,
): Promise<Result<OrchestratorOutcome, Error>> {
  const budget = resolveBudget(options.maxTokens);

  // 1. Load the task.
  const taskRead = getTask(db, taskId);
  if (!taskRead.ok) return err(taskRead.error);
  if (taskRead.value === null) {
    return err(new Error(`Task not found: ${taskId}`));
  }
  let task: TaskRecord = taskRead.value;

  // 2. Handle failure states.
  if (task.status.startsWith('failed_')) {
    if (options.retry !== true) {
      return err(
        new Error(
          `Task ${taskId} is in failure state '${task.status}'. ` +
            `Pass { retry: true } to roll back and re-run the failed stage.`,
        ),
      );
    }
    const rollback = FAILURE_ROLLBACK[task.status];
    if (rollback === undefined) {
      return err(new Error(`No rollback defined for status '${task.status}'`));
    }
    const rb = transitionTask(db, workspacePath, taskId, rollback);
    if (!rb.ok) return err(rb.error);
    task = rb.value;

    const traceR = writeTrace(db, workspacePath, 'orchestrator.retry', {
      taskId,
      rolledBackTo: rollback,
    });
    if (!traceR.ok) return err(traceR.error);
  }

  // 3. Terminal states finish immediately.
  if (task.status === 'completed' || task.status === 'archived') {
    return ok({
      taskId,
      finalStatus: 'completed',
      tokensUsed: 0,
      stageTokens: emptyStageTokens(),
      reportPath: '',
      finalOutputPath: '',
      stagesRun: [],
    });
  }

  // 4. Orchestrator.start trace.
  const startTrace = writeTrace(db, workspacePath, 'orchestrator.start', {
    taskId,
    startingStatus: task.status,
    budget,
    step: options.step === true,
  });
  if (!startTrace.ok) return err(startTrace.error);

  // 5. Stage loop.
  const stageTokens = emptyStageTokens();
  const stagesRun: Stage[] = [];
  let tokensUsed = 0;
  let reportPath = '';
  let finalOutputPath = '';

  while (true) {
    const nextStage = NEXT_STAGE[task.status];
    if (nextStage === undefined) {
      return err(new Error(`Unexpected task status: '${task.status}'`));
    }
    if (nextStage === null) {
      // Reached completed or archived via the last transition.
      break;
    }

    // Step-mode gate before every stage *after the first* this invocation.
    // The first stage always runs — otherwise `step: true` would be
    // observably indistinguishable from a no-op.
    if (options.step === true && stagesRun.length > 0) {
      const decided = options.confirmStep
        ? await options.confirmStep({
            fromStatus: task.status,
            nextStage,
            tokensUsed,
            budget,
          })
        : false;

      if (!decided) {
        const abortTrace = writeTrace(db, workspacePath, 'orchestrator.pause', {
          taskId,
          pausedBefore: nextStage,
          pausedFromStatus: task.status,
          tokensUsed,
          reason: options.confirmStep ? 'operator_aborted' : 'step',
        });
        if (!abortTrace.ok) return err(abortTrace.error);

        return ok({
          taskId,
          currentStatus: task.status,
          stagesRun,
          tokensUsed,
          stageTokens,
          reason: options.confirmStep ? 'operator_aborted' : 'step',
        });
      }
    }

    const stageStartTrace = writeTrace(db, workspacePath, 'orchestrator.stage_start', {
      taskId,
      stage: nextStage,
      fromStatus: task.status,
      tokensUsed,
    });
    if (!stageStartTrace.ok) return err(stageStartTrace.error);

    // Dispatch the stage. Each stage:
    //   - leaves the task status unchanged on failure (its own precondition)
    //   - writes forward on success (the stage owns its transition)
    const stageResult = await runStage(nextStage, db, workspacePath, taskId, options);

    if (!stageResult.ok) {
      recordAbort(db, workspacePath, taskId, nextStage, task.status, stageResult.error, tokensUsed);
      return err(stageResult.error);
    }

    // Re-read the task to pick up the status the stage just wrote.
    const reread = getTask(db, taskId);
    if (!reread.ok) return err(reread.error);
    if (reread.value === null) {
      return err(new Error(`Task vanished mid-pipeline: ${taskId}`));
    }
    task = reread.value;

    // Accumulate tokens.
    stageTokens[nextStage] = stageResult.value.tokensUsed;
    tokensUsed += stageResult.value.tokensUsed;
    if (stageResult.value.finalOutputPath !== undefined) {
      finalOutputPath = stageResult.value.finalOutputPath;
    }
    if (stageResult.value.reportPath !== undefined) {
      reportPath = stageResult.value.reportPath;
    }
    stagesRun.push(nextStage);

    const stageCompleteTrace = writeTrace(db, workspacePath, 'orchestrator.stage_complete', {
      taskId,
      stage: nextStage,
      toStatus: task.status,
      stageTokens: stageResult.value.tokensUsed,
      cumulativeTokens: tokensUsed,
    });
    if (!stageCompleteTrace.ok) return err(stageCompleteTrace.error);

    // Budget check AFTER accounting the stage.
    //
    // Intentionally we do NOT move the task to a `failed_*` state here:
    // the completed stage's work is legitimately on disk, so leaving the
    // task in the post-stage status means the next invocation (with a
    // larger budget) can resume cleanly from the next stage. The
    // `orchestrator.abort` trace is the durable record that this run
    // ended early.
    if (tokensUsed > budget) {
      writeTrace(db, workspacePath, 'orchestrator.abort', {
        taskId,
        stage: nextStage,
        fromStatus: task.status,
        toStatus: task.status,
        tokensUsed,
        budget,
        reason: 'budget_exceeded',
      });
      appendAuditLog(
        workspacePath,
        'orchestrator.abort',
        `Task ${taskId} aborted after stage '${nextStage}': budget ${budget} exceeded (used ${tokensUsed})`,
      );
      return err(
        new Error(
          `Research budget exceeded after stage '${nextStage}': ` +
            `used ${tokensUsed} tokens, budget ${budget}.`,
        ),
      );
    }
  }

  // 6. Render stage already ran inside the loop (it was the last stage),
  //    so the task should now be in `completed` status.
  if (task.status !== 'completed') {
    return err(
      new Error(`Orchestrator finished but task is '${task.status}', expected 'completed'`),
    );
  }

  const completeTrace = writeTrace(db, workspacePath, 'orchestrator.complete', {
    taskId,
    tokensUsed,
    stagesRun,
    reportPath,
    finalOutputPath,
  });
  if (!completeTrace.ok) return err(completeTrace.error);

  appendAuditLog(
    workspacePath,
    'orchestrator.complete',
    `Research task ${taskId} completed (${stagesRun.length} stages, ${tokensUsed} tokens)`,
  );

  return ok({
    taskId,
    finalStatus: 'completed',
    tokensUsed,
    stageTokens,
    reportPath,
    finalOutputPath,
    stagesRun,
  });
}

// ---------------------------------------------------------------------------
// Stage dispatch
// ---------------------------------------------------------------------------

interface StageRunResult {
  /** Tokens billed by this stage (0 for deterministic stages). */
  tokensUsed: number;
  /** Set by the integrator stage. */
  finalOutputPath?: string;
  /** Set by the render stage. */
  reportPath?: string;
}

async function runStage(
  stage: Stage,
  db: Database,
  workspacePath: string,
  taskId: string,
  options: OrchestratorOptions,
): Promise<Result<StageRunResult, Error>> {
  switch (stage) {
    case 'collect': {
      const r = collectEvidence(db, workspacePath, taskId);
      if (!r.ok) return err(r.error);
      return ok({ tokensUsed: 0 });
    }
    case 'summarize': {
      const summarizerOpts =
        options.models?.summarizer !== undefined ? { model: options.models.summarizer } : {};
      const r = await summarizeEvidence(db, workspacePath, taskId, options.client, summarizerOpts);
      if (!r.ok) return err(r.error);
      return ok({ tokensUsed: r.value.tokensUsed });
    }
    case 'critique': {
      const skepticOpts =
        options.models?.skeptic !== undefined ? { model: options.models.skeptic } : {};
      const r = await critiqueFindings(db, workspacePath, taskId, options.client, skepticOpts);
      if (!r.ok) return err(r.error);
      return ok({ tokensUsed: r.value.tokensUsed });
    }
    case 'integrate': {
      const integratorOpts =
        options.models?.integrator !== undefined ? { model: options.models.integrator } : {};
      const r = await integrateFindings(db, workspacePath, taskId, options.client, integratorOpts);
      if (!r.ok) return err(r.error);
      return ok({
        tokensUsed: r.value.tokensUsed,
        finalOutputPath: r.value.outputPath,
      });
    }
    case 'render': {
      return runRenderStage(db, workspacePath, taskId, options);
    }
  }
}

/**
 * L3 → L4 hand-off: reads the integrator's output, calls `renderReport`
 * to produce a markdown artifact under `workspace/outputs/reports/`, then
 * transitions the task `rendering` → `completed`.
 */
async function runRenderStage(
  db: Database,
  workspacePath: string,
  taskId: string,
  options: OrchestratorOptions,
): Promise<Result<StageRunResult, Error>> {
  // Resolve the task's workspace dir inside workspace/tasks/<dir>.
  const taskRead = getTask(db, taskId);
  if (!taskRead.ok) return err(taskRead.error);
  if (taskRead.value === null) return err(new Error(`Task not found: ${taskId}`));
  const task = taskRead.value;

  // task.workspace_path is like "tasks/tsk-<uuid>"; gatherTaskOutput wants
  // just the directory name under workspace/tasks/.
  const taskDirName = task.workspace_path.startsWith('tasks/')
    ? task.workspace_path.slice('tasks/'.length)
    : task.workspace_path;

  const outputs = gatherTaskOutput(workspacePath, taskDirName);
  if (!outputs.ok) return err(outputs.error);

  const reportOpts: Parameters<typeof renderReport>[2] = {
    client: options.client,
    ...(options.models?.report !== undefined && { model: options.models.report }),
  };

  const rendered = await renderReport(
    workspacePath,
    outputs.value.sources.map((s) => ({
      title: s.title,
      content: s.content,
      path: s.path,
    })),
    reportOpts,
  );
  if (!rendered.ok) return err(rendered.error);

  // Transition rendering → completed.
  const done = transitionTask(db, workspacePath, taskId, 'completed');
  if (!done.ok) return err(done.error);

  const tokensUsed = rendered.value.inputTokens + rendered.value.outputTokens;

  // Normalize the report path to a workspace-relative string when possible.
  const abs = rendered.value.outputPath;
  const rel = abs.startsWith(workspacePath)
    ? abs.slice(workspacePath.length).replace(/^\/+/, '')
    : abs;

  return ok({ tokensUsed, reportPath: rel });
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

/**
 * When a stage returns err, mark the task as `failed_<stage>`. The
 * transition must originate from the current status, which is always the
 * pre-stage status because the agent only writes forward on success.
 */
function recordAbort(
  db: Database,
  workspacePath: string,
  taskId: string,
  stage: Stage,
  fromStatus: TaskStatus,
  cause: Error,
  tokensUsed: number,
): void {
  const failureState = FAILURE_STATE[stage];
  // Best-effort: if the transition itself fails we still want to emit the
  // abort trace so the operator has a record.
  transitionTask(db, workspacePath, taskId, failureState);
  writeTrace(db, workspacePath, 'orchestrator.abort', {
    taskId,
    stage,
    fromStatus,
    toStatus: failureState,
    tokensUsed,
    reason: 'stage_error',
    message: cause.message,
  });
  appendAuditLog(
    workspacePath,
    'orchestrator.abort',
    `Task ${taskId} aborted in stage '${stage}': ${cause.message}`,
  );
}
