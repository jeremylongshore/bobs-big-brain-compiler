/**
 * Property-based tests for `promotion.ts` — the L4→L2 promotion rule gate.
 *
 * The promotion engine is the deterministic control-plane decision the whole
 * architecture rests on ("the model proposes, the system decides"). This suite
 * asserts the gate's *invariants* across generated inputs:
 *
 *  - rejection precedence: eligibility (path) is checked before anti-patterns,
 *    anti-patterns before the filesystem — so the rejection CODE is stable and
 *    order-independent of whether a file happens to exist
 *  - determinism: identical input → identical rejection code
 *  - a successful promotion always preserves the source (copy-not-move),
 *    emits a well-formed `sha256:<64-hex>` source hash, and lands at a target
 *    whose slug obeys every slug rule (lowercase, [a-z0-9-], no leading/
 *    trailing/double hyphen, ≤80 chars)
 *
 * Part of bead `intentional-cognition-os-0wy.8` (property tests for the
 * deterministic core).
 *
 * @module promotion.property.test
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace } from './index.js';
import { promoteArtifact, type PromotionType, VALID_PROMOTION_TYPES } from './promotion.js';

const TYPE_DIR: Record<PromotionType, string> = {
  topic: 'wiki/topics',
  concept: 'wiki/concepts',
  entity: 'wiki/entities',
  reference: 'wiki/sources',
};

// ---------------------------------------------------------------------------
// Shared workspace for the PURE (no-filesystem) precedence checks. The
// eligibility + anti-pattern rules return before any file I/O, so one
// workspace is reused across all generated paths.
// ---------------------------------------------------------------------------

interface Env {
  base: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-promo-prop-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  env = { base, db: dbRes.value };
});
afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

const wsPath = (): string => join(env.base, 'ws');

function rejectCode(sourcePath: string, targetType: PromotionType, confirm: boolean): string {
  const r = promoteArtifact(env.db, wsPath(), { sourcePath, targetType, confirm });
  return r.ok ? '<<OK>>' : r.error.code;
}

const seg = fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', 'sub', 'dir', 'node');

// ---------------------------------------------------------------------------
// Pure precedence properties (no real file needed — checks return early)
// ---------------------------------------------------------------------------

describe('promotion — rejection precedence (pure path checks)', () => {
  it('any path not under outputs/ is rejected INELIGIBLE_PATH (before FS / anti-pattern)', () => {
    const nonOutputs = fc
      .tuple(
        fc.constantFrom('wiki', 'raw', 'foo', 'tasks/x', 'x/outputs', 'outputs-other', '..'),
        seg,
      )
      .map(([prefix, s]) => `${prefix}/${s}.md`);
    fc.assert(
      fc.property(
        nonOutputs,
        fc.constantFrom(...VALID_PROMOTION_TYPES),
        fc.boolean(),
        (p, t, c) => {
          expect(rejectCode(p, t, c)).toBe('INELIGIBLE_PATH');
        },
      ),
      { numRuns: 150 },
    );
  });

  it('an outputs/ path containing tasks/ + drafts/ is rejected DRAFT_REJECTED, even with no file', () => {
    const draftPath = fc
      .tuple(seg, seg, seg)
      .map(([a, b, c]) => `outputs/${a}/tasks/${b}/drafts/${c}.md`);
    fc.assert(
      fc.property(draftPath, fc.constantFrom(...VALID_PROMOTION_TYPES), (p, t) => {
        // file does not exist — DRAFT_REJECTED must still win over FILE_NOT_FOUND
        expect(rejectCode(p, t, true)).toBe('DRAFT_REJECTED');
      }),
      { numRuns: 100 },
    );
  });

  it('an outputs/ path containing tasks/ + evidence/ (no drafts) is rejected EVIDENCE_REJECTED', () => {
    const evidencePath = fc.tuple(seg, seg).map(([a, b]) => `outputs/tasks/${a}/evidence/${b}.md`);
    fc.assert(
      fc.property(evidencePath, fc.constantFrom(...VALID_PROMOTION_TYPES), (p, t) => {
        expect(rejectCode(p, t, true)).toBe('EVIDENCE_REJECTED');
      }),
      { numRuns: 100 },
    );
  });

  it('rejection code is deterministic (same input → same code)', () => {
    const anyPath = fc.oneof(
      fc.tuple(fc.constantFrom('wiki', 'raw', 'foo'), seg).map(([p, s]) => `${p}/${s}.md`),
      fc.tuple(seg, seg).map(([a, b]) => `outputs/tasks/${a}/drafts/${b}.md`),
      fc.tuple(seg).map(([a]) => `outputs/${a}.md`),
    );
    fc.assert(
      fc.property(anyPath, fc.constantFrom(...VALID_PROMOTION_TYPES), fc.boolean(), (p, t, c) => {
        expect(rejectCode(p, t, c)).toBe(rejectCode(p, t, c));
      }),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Filesystem-backed properties — a fresh workspace + real source file per run.
// ---------------------------------------------------------------------------

const SLUG_CHARS = ['a', 'b', 'c', 'd', '1', '2', '3', ' ', '_', '-', '!', '.'];
const titleArb = fc
  .array(fc.constantFrom(...SLUG_CHARS), { minLength: 1, maxLength: 30 })
  .map((cs) => cs.join(''))
  .filter((s) => /[a-z0-9]/i.test(s)); // guarantee a non-empty slug

const invalidTypeArb = fc
  .string()
  .filter((s) => !(VALID_PROMOTION_TYPES as readonly string[]).includes(s));

describe('promotion — filesystem-backed rule gate', () => {
  it('valid file: invalid type → INVALID_TYPE, confirm=false → NOT_CONFIRMED, success preserves source + slug/hash invariants', () => {
    fc.assert(
      fc.property(
        titleArb,
        fc.constantFrom(...VALID_PROMOTION_TYPES),
        invalidTypeArb,
        (title, validType, invalidType) => {
          const base = mkdtempSync(join(tmpdir(), 'ico-promo-fs-'));
          try {
            const ws = initWorkspace('ws', base);
            if (!ws.ok) throw ws.error;
            const dbRes = initDatabase(ws.value.dbPath);
            if (!dbRes.ok) throw dbRes.error;
            const db = dbRes.value;
            const root = join(base, 'ws');
            const srcRel = 'outputs/src.md';
            const srcAbs = join(root, srcRel);
            mkdirSync(dirname(srcAbs), { recursive: true });
            // JSON-quote the title so YAML always reads it as a string — an
            // unquoted title like `1` or `-1` would parse as a number and trip
            // the missing-title check before the type check we're exercising.
            writeFileSync(
              srcAbs,
              `---\ntitle: ${JSON.stringify(title)}\n---\n\nbody content\n`,
              'utf-8',
            );

            try {
              // invalid type → INVALID_TYPE (checked before the confirm gate)
              const badType = promoteArtifact(db, root, {
                sourcePath: srcRel,
                targetType: invalidType as unknown as PromotionType,
                confirm: true,
              });
              expect(badType.ok).toBe(false);
              if (!badType.ok) expect(badType.error.code).toBe('INVALID_TYPE');

              // valid type but unconfirmed → NOT_CONFIRMED
              const unconfirmed = promoteArtifact(db, root, {
                sourcePath: srcRel,
                targetType: validType,
                confirm: false,
              });
              expect(unconfirmed.ok).toBe(false);
              if (!unconfirmed.ok) expect(unconfirmed.error.code).toBe('NOT_CONFIRMED');

              // valid + confirmed → success
              const ok = promoteArtifact(db, root, {
                sourcePath: srcRel,
                targetType: validType,
                confirm: true,
              });
              expect(ok.ok).toBe(true);
              if (!ok.ok) return;

              // copy-not-move: the source is preserved
              expect(existsSync(srcAbs)).toBe(true);
              // hash is well-formed
              expect(ok.value.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
              // target lands in the type's directory
              expect(dirname(ok.value.targetPath)).toBe(TYPE_DIR[validType]);
              // slug obeys every slug rule
              const slug = basename(ok.value.targetPath, '.md');
              expect(slug.length).toBeGreaterThanOrEqual(1);
              expect(slug.length).toBeLessThanOrEqual(80);
              expect(slug).toMatch(/^[a-z0-9-]+$/);
              expect(slug.startsWith('-')).toBe(false);
              expect(slug.endsWith('-')).toBe(false);
              expect(slug.includes('--')).toBe(false);
            } finally {
              closeDatabase(db);
            }
          } finally {
            rmSync(base, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
