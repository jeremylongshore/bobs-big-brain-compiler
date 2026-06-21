/**
 * Canonical content-derived UUID v5 derivation for spool-emitted candidate IDs.
 *
 * This module is the SINGLE SOURCE OF TRUTH for how a logical memory's stable
 * identifier is computed from its content. It is the load-bearing contract
 * between ICO (the emitter, which stamps `id` onto every `SpoolMemoryCandidate`
 * in `spool.ts`) and INTKB (the consumer, which uses that `id` as its id-dedupe
 * key `findById(candidate.id)` and as the foreign-key reference on
 * `CuratedMemory.candidateId`).
 *
 * The derivation MUST be byte-identical on both sides. If ICO and INTKB diverge
 * by even one byte (namespace, NUL delimiter, ordering, or hashing), the same
 * logical memory gets two different IDs, which silently breaks dedupe and the
 * audit-chain link. The namespace constant is locked in `@ico/types`
 * (`SPOOL_UUID_NAMESPACE`) and the name composition lives here in one place,
 * rather than being re-spelled at each call site.
 *
 * Previously the v5 implementation was an inline private helper inside
 * `spool.ts`. It was extracted here (EPIC 1, bead `compile-then-govern-8da.5`)
 * so the derivation is importable and provably shared rather than copy-pasted.
 * It lives in `@ico/kernel` (not `@ico/types`) because it depends on
 * `node:crypto`; `@ico/types` is deliberately a Node-free pure-Zod schema layer.
 *
 * @module @ico/kernel/uuid
 */

import { createHash } from 'node:crypto';

import { SPOOL_UUID_NAMESPACE } from '@ico/types';

// ---------------------------------------------------------------------------
// RFC 4122 §4.3: name-based UUID v5 (SHA-1)
// ---------------------------------------------------------------------------

/** Parse a canonical UUID string into a 16-byte Buffer. */
function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/** Format a 16-byte Buffer back into a canonical 8-4-4-4-12 UUID string. */
function uuidBytesToString(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Compute a deterministic UUID v5 from `(namespace, name)` per RFC 4122 §4.3.
 *
 * SHA-1 of `(namespace bytes || name UTF-8 bytes)`, truncated to 16 bytes, with
 * the version (5) and variant (RFC 4122) bits patched. Node's built-in
 * `crypto.randomUUID()` is v4 only and there is no native v5, so this is a small
 * inline implementation rather than a third-party dependency.
 *
 * Deterministic by construction: the same `(namespace, name)` pair always yields
 * the same UUID, and any change to either input yields a different UUID. This is
 * the property the spool contract depends on.
 *
 * @param namespace - A canonical UUID string used as the v5 namespace.
 * @param name      - The name to hash under that namespace (UTF-8 encoded).
 * @returns The canonical UUID v5 string.
 */
export function uuidV5(namespace: string, name: string): string {
  const nsBytes = uuidStringToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5: top 4 bits of byte 6 = 0101.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122: top 2 bits of byte 8 = 10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return uuidBytesToString(bytes);
}

// ---------------------------------------------------------------------------
// Canonical spool candidate-ID composition (the cross-repo contract)
// ---------------------------------------------------------------------------

/**
 * NUL byte (`\x00`) used to delimit the components of a spool candidate name.
 *
 * A control character is used deliberately: none of the components
 * (`workspaceId`, a relative path, a lowercase hex digest) can legitimately
 * contain it, so the composition is unambiguous and not vulnerable to a
 * delimiter-injection collision (e.g. a `relPath` that ends with what looks
 * like the start of a `bodySha256`).
 */
const CANDIDATE_NAME_DELIMITER = '\x00';

/**
 * Compose the canonical v5 *name* string for a spool candidate from its content
 * coordinates. Exposed separately from {@link deriveSpoolCandidateId} so tests
 * (and INTKB's cross-verification path) can assert the exact byte composition
 * without re-deriving the hash.
 *
 * Composition (NUL-delimited, UTF-8): `{workspaceId}\x00{relPath}\x00{bodySha256}`.
 *
 * @param workspaceId - Final path component of the ICO workspace directory
 *                      (`basename(resolve(workspacePath))`).
 * @param relPath     - Workspace-relative path of the compiled page
 *                      (e.g. `wiki/concepts/foo.md`).
 * @param bodySha256  - Lowercase SHA-256 hex digest of the page body (after
 *                      frontmatter is stripped and trimmed).
 * @returns The NUL-delimited name string.
 */
export function spoolCandidateName(
  workspaceId: string,
  relPath: string,
  bodySha256: string,
): string {
  return [workspaceId, relPath, bodySha256].join(CANDIDATE_NAME_DELIMITER);
}

/**
 * Derive the canonical, content-stable UUID v5 candidate ID for a spool memory.
 *
 * This is THE function ICO and INTKB must agree on byte-for-byte. ICO calls it
 * in `buildCandidate` to stamp `SpoolMemoryCandidate.id`; INTKB uses the
 * resulting id as its dedupe key and may recompute it via this same derivation
 * to cross-verify that an emitted candidate's id matches its content.
 *
 * Determinism guarantees:
 * - Same `(workspaceId, relPath, bodySha256)` always yields the same id, across
 *   processes, machines, and repositories.
 * - Any change to any component yields a different id.
 *
 * @param workspaceId - Final path component of the ICO workspace directory.
 * @param relPath     - Workspace-relative path of the compiled page.
 * @param bodySha256  - Lowercase SHA-256 hex digest of the page body.
 * @returns The canonical UUID v5 candidate id.
 */
export function deriveSpoolCandidateId(
  workspaceId: string,
  relPath: string,
  bodySha256: string,
): string {
  return uuidV5(SPOOL_UUID_NAMESPACE, spoolCandidateName(workspaceId, relPath, bodySha256));
}
