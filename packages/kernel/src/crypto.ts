/**
 * Shared cryptographic helpers for the kernel.
 *
 * Centralising small primitives like `sha256Hex` avoids the silent-drift
 * risk that comes from byte-for-byte duplicating the same function across
 * `traces.ts` (the chain writer) and `audit-verify.ts` (the chain
 * verifier). If the two ever disagree on hash semantics, the chain
 * silently fails to verify even when the audit log is intact — see
 * code-reviewer subagent finding 2026-05-24 + bead
 * `intentional-cognition-os-zcc.5`.
 *
 * @module crypto
 */

import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest of a string, treated as UTF-8 bytes. Returns the
 * standard 64-char lowercase hex digest.
 *
 * Used for the per-line `prev_hash` field in `audit/traces/*.jsonl`:
 * each event's `prev_hash` is the SHA-256 of the previous line's full
 * raw text. Writer (`traces.ts:writeTrace`) and verifier
 * (`audit-verify.ts:verifyAuditChain`) MUST call this function so the
 * computed and expected hashes always agree.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}
