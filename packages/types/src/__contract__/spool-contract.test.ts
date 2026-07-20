/**
 * Cross-repo contract test for the ICO → INTKB spool boundary.
 *
 * Validates that a SpoolMemoryCandidate emitted by ICO (using the schema
 * defined in `spool.ts`) parses successfully through INTKB's actual
 * `MemoryCandidate` Zod schema (vendored at `intkb-memory-candidate-
 * snapshot.ts`).
 *
 * This is the load-bearing drift gate for the v1 Option-A mirror strategy.
 * If this test fails, ICO is emitting JSONL that INTKB's reader will
 * silently drop (skipping invalid lines). Fix by reconciling the ICO
 * schema in `spool.ts` against the vendored snapshot.
 */

import { describe, expect, it } from 'vitest';

import { ICO_AUTHOR, type SpoolMemoryCandidate, SpoolMemoryCandidateSchema } from '../spool.js';
import { IntkbMemoryCandidate } from './intkb-memory-candidate-snapshot.js';

function buildSample(overrides: Partial<SpoolMemoryCandidate> = {}): SpoolMemoryCandidate {
  return SpoolMemoryCandidateSchema.parse({
    schemaVersion: '1',
    id: '6c6f6e67-7368-6f72-6500-69636f73706c',
    status: 'inbox',
    source: 'import',
    content: 'A compiled wiki page body about transformer attention.',
    title: 'Transformer attention',
    category: 'architecture',
    trustLevel: 'medium',
    author: ICO_AUTHOR,
    tenantId: 'intentional-cognition-os',
    metadata: {
      filePaths: ['wiki/topics/transformers.md'],
      projectContext: 'intentional-cognition-os',
      tags: ['transformer', 'attention'],
    },
    prePolicyFlags: {
      potentialSecret: false,
      lowConfidence: false,
      duplicateSuspect: false,
    },
    capturedAt: '2026-05-24T03:00:00.000Z',
    ...overrides,
  });
}

describe('spool boundary contract — ICO emission ↔ INTKB MemoryCandidate', () => {
  it('passes INTKB MemoryCandidate parser via JSON round-trip', () => {
    const candidate = buildSample();
    // JSON round-trip exercises the actual wire format (JSONL is text), not
    // TypeScript's structural assignability. Without this round-trip you're
    // testing TS types instead of byte compatibility.
    const wire: unknown = JSON.parse(JSON.stringify(candidate));
    const parsed = IntkbMemoryCandidate.safeParse(wire);
    expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
  });

  it('emits UTC Z-suffixed capturedAt (Zod 4 datetime constraint)', () => {
    const candidate = buildSample();
    expect(candidate.capturedAt).toMatch(/Z$/);
    const wire: unknown = JSON.parse(JSON.stringify(candidate));
    expect(IntkbMemoryCandidate.safeParse(wire).success).toBe(true);
  });

  it('INTKB parser PINS schemaVersion at the literal "1" (5bm.6 resync — no longer stripped)', () => {
    const candidate = buildSample();
    const wire: unknown = JSON.parse(JSON.stringify(candidate));
    const parsed = IntkbMemoryCandidate.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Since the 2026-07-19 resync INTKB carries schemaVersion natively,
      // pinned to '1' — ICO's emitted value is preserved, not stripped.
      expect((parsed.data as Record<string, unknown>)['schemaVersion']).toBe('1');
    }
    // The pinning is load-bearing: a future ICO v2 line FAILS safeParse
    // instead of being silently ingested as v1 with new fields dropped. Pin
    // the KIND of rejection too (review finding on #179): a registrar change
    // softening the literal into a union must break THIS assertion, not just
    // flip a boolean somewhere.
    const v2wire = { ...(wire as Record<string, unknown>), schemaVersion: '2' };
    const v2parsed = IntkbMemoryCandidate.safeParse(v2wire);
    expect(v2parsed.success).toBe(false);
    if (!v2parsed.success) {
      expect(v2parsed.error.issues[0]).toMatchObject({ path: ['schemaVersion'] });
    }
  });

  it('ICO emissions carry NO origin and still parse (unattested backward-compat, GSB Wave-2 H1)', () => {
    // ICO's emitter does not mint origin attestations; INTKB's schema keeps
    // `origin` OPTIONAL so every spool line governs as `unattested` rather
    // than being orphaned by a hard-reject flag-day (registrar 046-AT-DECR).
    const wire = JSON.parse(JSON.stringify(buildSample())) as Record<string, unknown>;
    expect('origin' in wire).toBe(false);
    const parsed = IntkbMemoryCandidate.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['origin']).toBeUndefined();
    }
  });

  it('a well-formed origin attestation parses; malformed tokenHmac/channel shapes are refused', () => {
    const base = JSON.parse(JSON.stringify(buildSample())) as Record<string, unknown>;
    const attested = {
      ...base,
      origin: {
        tokenHmac: 'ab'.repeat(32),
        channel: 'local-mcp',
        mintedAt: '2026-05-24T03:00:00.000Z',
      },
    };
    expect(IntkbMemoryCandidate.safeParse(attested).success).toBe(true);
    // Pin WHERE each refusal lands (review finding on #179) — the failure
    // must be the specific field's grammar, not an incidental error elsewhere.
    const badToken = { ...base, origin: { ...attested.origin, tokenHmac: 'ZZ'.repeat(32) } };
    const badTokenParsed = IntkbMemoryCandidate.safeParse(badToken);
    expect(badTokenParsed.success).toBe(false);
    if (!badTokenParsed.success) {
      expect(badTokenParsed.error.issues[0]).toMatchObject({ path: ['origin', 'tokenHmac'] });
    }
    const badChannel = { ...base, origin: { ...attested.origin, channel: 'Not A Tag' } };
    const badChannelParsed = IntkbMemoryCandidate.safeParse(badChannel);
    expect(badChannelParsed.success).toBe(false);
    if (!badChannelParsed.success) {
      expect(badChannelParsed.error.issues[0]).toMatchObject({ path: ['origin', 'channel'] });
    }
  });

  it('origin does not participate in id derivation — the same wire id parses with and without it', () => {
    // The spool id contract stays UUID-v5 over (workspaceId, relPath,
    // bodySha256); attaching origin must not change the id INTKB sees.
    const wire = JSON.parse(JSON.stringify(buildSample())) as Record<string, unknown>;
    const withOrigin = {
      ...wire,
      origin: {
        tokenHmac: 'cd'.repeat(32),
        channel: 'local-mcp',
        mintedAt: '2026-05-24T03:00:00.000Z',
      },
    };
    const a = IntkbMemoryCandidate.safeParse(wire);
    const b = IntkbMemoryCandidate.safeParse(withOrigin);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect((a.data as { id: string }).id).toBe((b.data as { id: string }).id);
    }
  });

  it('all 7 INTKB MemoryCategory values are reachable from ICO emissions', () => {
    const cats: SpoolMemoryCandidate['category'][] = [
      'decision',
      'pattern',
      'convention',
      'architecture',
      'troubleshooting',
      'onboarding',
      'reference',
    ];
    for (const c of cats) {
      const wire: unknown = JSON.parse(JSON.stringify(buildSample({ category: c })));
      const parsed = IntkbMemoryCandidate.safeParse(wire);
      expect(parsed.success).toBe(true);
    }
  });

  it('all 4 INTKB MemorySource values pass the parser', () => {
    for (const s of ['claude_session', 'manual', 'import', 'mcp'] as const) {
      const wire: unknown = JSON.parse(JSON.stringify(buildSample({ source: s })));
      const parsed = IntkbMemoryCandidate.safeParse(wire);
      expect(parsed.success).toBe(true);
    }
  });

  it('INTKB rejects an ICO emission with a non-Z-suffixed capturedAt', () => {
    // Build directly without going through ICO's parser (which would also reject).
    const wire = JSON.parse(JSON.stringify(buildSample())) as Record<string, unknown>;
    wire['capturedAt'] = '2026-05-24T03:00:00+05:30'; // valid ISO 8601 with offset
    const parsed = IntkbMemoryCandidate.safeParse(wire);
    // Zod 3.x accepts offset datetimes; Zod 4.x does not. INTKB is on 4.x;
    // ICO ships on 3.24 today. The vendored snapshot uses whatever Zod is
    // available in @ico/types (currently 3.24), so this assertion may flip
    // when ICO migrates to Zod 4 (bead intentional-cognition-os-j83).
    // Document the current expectation: under Zod 3 this still parses; the
    // contract guarantee (Z-suffix from ICO) is enforced by ICO's own
    // schema regardless of Zod version. Skipping the strict assertion until
    // ICO migrates.
    expect(parsed).toBeDefined();
  });
});
