/**
 * Eval spec discovery + parsing (E10-B01).
 *
 * Loads `.eval.yaml` files from the workspace's `evals/` tree, validates
 * the minimum shape, and returns typed {@link EvalSpec} objects. Bad
 * files surface as `err(Error)` with the offending path so the runner
 * can skip them with a clear message instead of crashing the batch.
 *
 * @module evals/loader
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { err, ok, type Result } from '@ico/types';

import type { EvalSpec, EvalType } from './types.js';

const VALID_TYPES: ReadonlySet<EvalType> = new Set([
  'retrieval',
  'smoke',
  'compilation',
  'citation',
]);

const VALID_SMOKE_CHECKS = new Set([
  'fts5-index-nonempty',
  'no-failed-tasks',
  'audit-chain-intact',
]);

const VALID_COMPILATION_PASSES = new Set([
  'summarize',
  'extract',
  'synthesize',
  'link',
  'contradict',
  'gap',
]);

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

function validateSpec(raw: unknown, sourcePath: string): Result<EvalSpec, Error> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err(new Error(`${sourcePath}: spec must be a YAML object`));
  }
  const obj = raw as Record<string, unknown>;

  const id = obj['id'];
  const name = obj['name'];
  const type = obj['type'];
  if (typeof id !== 'string' || id.trim() === '') {
    return err(new Error(`${sourcePath}: 'id' must be a non-empty string`));
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return err(new Error(`${sourcePath}: 'name' must be a non-empty string`));
  }
  if (typeof type !== 'string' || !VALID_TYPES.has(type as EvalType)) {
    return err(
      new Error(`${sourcePath}: 'type' must be one of ${Array.from(VALID_TYPES).join(', ')}`),
    );
  }

  const threshold = obj['threshold'];
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold < 0 || threshold > 1)
  ) {
    return err(new Error(`${sourcePath}: 'threshold' must be a number in [0, 1]`));
  }

  if (type === 'retrieval') {
    const question = obj['question'];
    const expected = obj['expected_pages'];
    const k = obj['k'];
    if (typeof question !== 'string' || question.trim() === '') {
      return err(new Error(`${sourcePath}: retrieval spec needs non-empty 'question'`));
    }
    if (!Array.isArray(expected) || expected.length === 0) {
      return err(new Error(`${sourcePath}: retrieval spec needs non-empty 'expected_pages' array`));
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (typeof expected[i] !== 'string') {
        return err(new Error(`${sourcePath}: expected_pages[${i}] must be a string`));
      }
    }
    if (k !== undefined && (typeof k !== 'number' || k < 1 || !Number.isFinite(k))) {
      return err(new Error(`${sourcePath}: 'k' must be a positive integer`));
    }
    for (const field of ['min_recall', 'min_precision'] as const) {
      const v = obj[field];
      if (v !== undefined && (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1)) {
        return err(new Error(`${sourcePath}: '${field}' must be a number in [0, 1]`));
      }
    }
  } else if (type === 'smoke') {
    const check = obj['check'];
    if (typeof check !== 'string' || !VALID_SMOKE_CHECKS.has(check)) {
      return err(
        new Error(
          `${sourcePath}: smoke 'check' must be one of ${Array.from(VALID_SMOKE_CHECKS).join(', ')}`,
        ),
      );
    }
  } else if (type === 'citation') {
    const target = obj['target_file'];
    if (typeof target !== 'string' || target.trim() === '') {
      return err(
        new Error(
          `${sourcePath}: citation spec needs non-empty 'target_file' (workspace-relative)`,
        ),
      );
    }
    const requireCit = obj['require_citations'];
    if (requireCit !== undefined && typeof requireCit !== 'boolean') {
      return err(new Error(`${sourcePath}: 'require_citations' must be a boolean`));
    }
    const expected = obj['expected_citations'];
    if (expected !== undefined) {
      if (!Array.isArray(expected)) {
        return err(new Error(`${sourcePath}: 'expected_citations' must be a string array`));
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (typeof expected[i] !== 'string') {
          return err(new Error(`${sourcePath}: expected_citations[${i}] must be a string`));
        }
      }
    }
  } else if (type === 'compilation') {
    const pass = obj['pass'];
    const target = obj['target_page'];
    const criteria = obj['criteria'];
    if (typeof pass !== 'string' || !VALID_COMPILATION_PASSES.has(pass)) {
      return err(
        new Error(
          `${sourcePath}: compilation 'pass' must be one of ${Array.from(VALID_COMPILATION_PASSES).join(', ')}`,
        ),
      );
    }
    if (typeof target !== 'string' || target.trim() === '') {
      return err(
        new Error(`${sourcePath}: compilation spec needs non-empty 'target_page' (wiki-relative)`),
      );
    }
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return err(new Error(`${sourcePath}: compilation spec needs non-empty 'criteria' array`));
    }
    const seenIds = new Set<string>();
    for (let i = 0; i < criteria.length; i += 1) {
      const c: unknown = criteria[i];
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof (c as Record<string, unknown>)['id'] !== 'string' ||
        typeof (c as Record<string, unknown>)['description'] !== 'string'
      ) {
        return err(
          new Error(`${sourcePath}: criteria[${i}] must be { id, description } (both strings)`),
        );
      }
      const cid = (c as Record<string, unknown>)['id'] as string;
      if (seenIds.has(cid)) {
        return err(
          new Error(`${sourcePath}: criteria[${i}].id '${cid}' duplicates an earlier criterion id`),
        );
      }
      seenIds.add(cid);
    }
  }

  return ok(obj as unknown as EvalSpec);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load + validate a single eval spec file. */
export function loadEvalSpec(absPath: string): Result<EvalSpec, Error> {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (e) {
    return err(
      new Error(
        `Failed to read eval spec ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch (e) {
    return err(
      new Error(`${absPath}: YAML parse failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  return validateSpec(parsed, absPath);
}

/**
 * Recursively walk `evalsDir` (typically `<workspace>/evals/`), collecting
 * every `*.eval.yaml` or `*.eval.yml` file. The returned paths are
 * absolute and sorted for determinism.
 *
 * When the directory does not exist, returns `ok([])` so the runner can
 * report "no specs found" rather than fail.
 */
export function discoverEvalSpecs(evalsDir: string): Result<string[], Error> {
  const out: string[] = [];
  try {
    const stack: string[] = [resolve(evalsDir)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (e) {
        // Missing root: not an error, just no specs.
        if (current === resolve(evalsDir)) return ok([]);
        return err(
          new Error(`Failed to read ${current}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      for (const ent of entries) {
        const full = join(current, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (
          ent.isFile() &&
          (ent.name.endsWith('.eval.yaml') || ent.name.endsWith('.eval.yml'))
        ) {
          out.push(full);
        }
      }
    }
    out.sort();
    return ok(out);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Discover + load every eval spec under `evalsDir`. Returns one Result
 * per file so callers can surface partial successes (one bad spec
 * doesn't kill the whole batch).
 */
export function loadAllEvalSpecs(
  evalsDir: string,
): Result<Array<{ path: string; spec: Result<EvalSpec, Error> }>, Error> {
  const discovery = discoverEvalSpecs(evalsDir);
  if (!discovery.ok) return err(discovery.error);
  const loaded = discovery.value.map((p) => ({ path: p, spec: loadEvalSpec(p) }));
  return ok(loaded);
}

/** Internal helper for tests — returns true when the path is a directory. */
export function isDir(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
