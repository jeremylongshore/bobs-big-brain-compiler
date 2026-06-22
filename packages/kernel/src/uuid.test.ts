import { describe, expect, it } from 'vitest';

import { SPOOL_UUID_NAMESPACE } from '@ico/types';

import { deriveSpoolCandidateId, spoolCandidateName, uuidV5 } from './uuid.js';

// A canonical UUID-string regex (8-4-4-4-12 hex). The third group's leading
// nibble pins the version, the fourth group's leading nibble pins the variant.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The standard DNS namespace from RFC 4122 Appendix C. Used only to assert our
// v5 implementation matches the published RFC test vector.
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Two distinct lowercase SHA-256-shaped digests (64 hex chars). Built by
// concatenation so no single 64-char hex literal sits in the source.
const SHA_A = '0123456789abcdef' + '0123456789abcdef' + '0123456789abcdef' + '0123456789abcdef';
const SHA_B = 'fedcba9876543210' + 'fedcba9876543210' + 'fedcba9876543210' + 'fedcba9876543210';

describe('uuidV5 - RFC 4122 §4.3 name-based UUID', () => {
  it('matches the published RFC 4122 test vector (DNS namespace, www.example.com)', () => {
    // RFC 4122 §4.3 canonical example. If this byte changes, the algorithm
    // (and therefore cross-repo agreement with INTKB) is broken.
    expect(uuidV5(DNS_NAMESPACE, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('produces a syntactically valid UUID', () => {
    expect(uuidV5(SPOOL_UUID_NAMESPACE, 'anything')).toMatch(UUID_RE);
  });

  it('sets the version nibble to 5 and the RFC 4122 variant', () => {
    const id = uuidV5(SPOOL_UUID_NAMESPACE, 'version-check');
    // Third group, first char is the version: must be '5'.
    expect(id[14]).toBe('5');
    // Fourth group, first char is the variant: top two bits 10 => one of 8/9/a/b.
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is deterministic - same (namespace, name) yields the same id across runs', () => {
    const first = uuidV5(SPOOL_UUID_NAMESPACE, 'repeat-me');
    const second = uuidV5(SPOOL_UUID_NAMESPACE, 'repeat-me');
    const third = uuidV5(SPOOL_UUID_NAMESPACE, 'repeat-me');
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('different name yields a different id', () => {
    expect(uuidV5(SPOOL_UUID_NAMESPACE, 'name-one')).not.toBe(
      uuidV5(SPOOL_UUID_NAMESPACE, 'name-two'),
    );
  });

  it('different namespace yields a different id for the same name', () => {
    expect(uuidV5(SPOOL_UUID_NAMESPACE, 'shared-name')).not.toBe(
      uuidV5(DNS_NAMESPACE, 'shared-name'),
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('not-a-uuid', 'x')).toThrow(/Invalid UUID/);
  });
});

describe('spoolCandidateName - canonical NUL-delimited name composition', () => {
  it('joins components with a NUL byte in (workspaceId, relPath, bodySha256) order', () => {
    expect(spoolCandidateName('ws', 'wiki/a.md', SHA_A)).toBe(
      'ws' + '\x00' + 'wiki/a.md' + '\x00' + SHA_A,
    );
  });

  it('is collision-resistant across the delimiter: re-grouping components changes the name', () => {
    // Without a NUL delimiter, ('ab','c') and ('a','bc') would both be 'abc'.
    // The NUL guarantees they stay distinct.
    expect(spoolCandidateName('ab', 'c', SHA_A)).not.toBe(spoolCandidateName('a', 'bc', SHA_A));
  });
});

describe('deriveSpoolCandidateId - content-derived candidate ID (ICO <-> INTKB contract)', () => {
  const WORKSPACE = 'my-workspace';
  const REL_PATH = 'wiki/concepts/foo.md';

  it('matches the locked golden vector for a known content triple', () => {
    // GOLDEN. This id is the byte-for-byte contract value. INTKB must compute
    // the identical id from the identical (workspaceId, relPath, bodySha256).
    // If this changes, ICO and INTKB will assign different ids to the same
    // logical memory and dedupe + the audit-chain link silently break.
    expect(deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A)).toBe(
      'e0e430cb-ede6-53ae-8bd0-1edc3b945c6f',
    );
  });

  it('equals uuidV5(SPOOL_UUID_NAMESPACE, spoolCandidateName(...)) - same derivation, one place', () => {
    expect(deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A)).toBe(
      uuidV5(SPOOL_UUID_NAMESPACE, spoolCandidateName(WORKSPACE, REL_PATH, SHA_A)),
    );
  });

  it('is deterministic - same content triple yields the same id across runs', () => {
    const a = deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A);
    const b = deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A);
    const c = deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toMatch(UUID_RE);
  });

  it('changing the workspace id changes the candidate id', () => {
    expect(deriveSpoolCandidateId('workspace-a', REL_PATH, SHA_A)).not.toBe(
      deriveSpoolCandidateId('workspace-b', REL_PATH, SHA_A),
    );
  });

  it('changing the relative path changes the candidate id', () => {
    expect(deriveSpoolCandidateId(WORKSPACE, 'wiki/concepts/foo.md', SHA_A)).not.toBe(
      deriveSpoolCandidateId(WORKSPACE, 'wiki/concepts/bar.md', SHA_A),
    );
  });

  it('changing the body hash (new content) changes the candidate id', () => {
    expect(deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_A)).not.toBe(
      deriveSpoolCandidateId(WORKSPACE, REL_PATH, SHA_B),
    );
  });

  it('the derivation uses the locked SPOOL_UUID_NAMESPACE constant', () => {
    // Guards against an accidental namespace edit: the golden vector above was
    // computed under this exact namespace value.
    expect(SPOOL_UUID_NAMESPACE).toBe('6c6f6e67-7368-6f72-6500-69636f73706c');
  });
});
