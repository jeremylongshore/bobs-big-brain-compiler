/**
 * Tests for friendlyError. Covers each known pattern plus the
 * fall-through to verbatim messages.
 */

import { describe, expect, it } from 'vitest';

import { friendlyError } from './friendly-errors.js';

/** Build a Node fs-style error with a `code` and `path`. */
function fsError(code: string, path: string): Error & { code: string; path: string } {
  const e = new Error(`${code}: ${path}`) as Error & { code: string; path: string };
  e.code = code;
  e.path = path;
  return e;
}

describe('friendlyError', () => {
  it('returns "Unknown error" for null/undefined', () => {
    expect(friendlyError(null)).toBe('Unknown error');
    expect(friendlyError(undefined)).toBe('Unknown error');
  });

  it('stringifies non-Error throwables', () => {
    expect(friendlyError(42)).toBe('42');
    expect(friendlyError('boom')).toBe('boom');
  });

  it('formats ENOSPC as a disk-full hint', () => {
    const out = friendlyError(fsError('ENOSPC', '/ws/recall/cards/x.md.tmp'));
    expect(out).toMatch(/Disk full/);
    expect(out).toContain('/ws/recall/cards/x.md.tmp');
  });

  it('formats EACCES as a permission hint', () => {
    const out = friendlyError(fsError('EACCES', '/ws/audit/log.md'));
    expect(out).toMatch(/Permission denied/);
    expect(out).toContain('/ws/audit/log.md');
  });

  it('formats ENOENT as a not-found hint', () => {
    const out = friendlyError(fsError('ENOENT', '/ws/recall/quizzes/foo.md'));
    expect(out).toMatch(/not found/);
  });

  it('formats EISDIR as the expected-file hint', () => {
    const out = friendlyError(fsError('EISDIR', '/ws/recall/cards/archive.md'));
    expect(out).toMatch(/Expected a file but found a directory/);
  });

  it('formats EMFILE/ENFILE as the open-files hint', () => {
    expect(friendlyError(fsError('EMFILE', '/x'))).toMatch(/Too many open files/);
    expect(friendlyError(fsError('ENFILE', '/x'))).toMatch(/Too many open files/);
  });

  it('formats EBUSY as the resource-busy hint', () => {
    expect(friendlyError(fsError('EBUSY', '/x'))).toMatch(/Resource busy/);
  });

  it('formats EROFS as the read-only hint', () => {
    expect(friendlyError(fsError('EROFS', '/x'))).toMatch(/read-only/);
  });

  it('detects SQLite lock contention via error message', () => {
    const out = friendlyError(new Error('SqliteError: database is locked'));
    expect(out).toMatch(/Workspace database is locked/);
  });

  it('detects SQLITE_BUSY via the code', () => {
    const e = new Error('busy') as Error & { code: string };
    e.code = 'SQLITE_BUSY';
    expect(friendlyError(e)).toMatch(/Workspace database is locked/);
  });

  it('detects SQLITE_READONLY and SQLITE_CORRUPT', () => {
    const ro = new Error('readonly') as Error & { code: string };
    ro.code = 'SQLITE_READONLY';
    expect(friendlyError(ro)).toMatch(/read-only/);

    const co = new Error('corrupt') as Error & { code: string };
    co.code = 'SQLITE_CORRUPT';
    expect(friendlyError(co)).toMatch(/corrupted/);
  });

  it('rewrites Claude API category errors', () => {
    expect(friendlyError(new Error('Claude API authentication_error (HTTP 401): bad key'))).toMatch(
      /ANTHROPIC_API_KEY/,
    );
    expect(
      friendlyError(new Error('Claude API rate_limit_error (HTTP 429): too many requests')),
    ).toMatch(/rate limit/i);
    expect(friendlyError(new Error('Claude API overloaded_error (HTTP 529): overloaded'))).toMatch(
      /overloaded/i,
    );
    expect(friendlyError(new Error('Claude API bad_request_error (HTTP 400): bad input'))).toMatch(
      /rejected the request/,
    );
    expect(friendlyError(new Error('Claude API server_error (HTTP 500): server boom'))).toMatch(
      /server error/,
    );
  });

  it('returns the verbatim message for unrecognised errors', () => {
    expect(friendlyError(new Error('something nobody anticipated'))).toBe(
      'something nobody anticipated',
    );
  });
});
