/**
 * Friendly error message formatter (E10-B05).
 *
 * Maps known error shapes — Node fs errno codes, SQLite errors, Claude
 * API categories — to actionable human-readable messages. The CLI's
 * top-level error handler and per-command error paths funnel through
 * here so the operator never sees a stack trace for a known failure.
 *
 * Returns the original message verbatim when no pattern matches; the
 * caller decides whether to wrap further. Pure function — no I/O.
 *
 * @module lib/friendly-errors
 */

interface NodeErrnoLike {
  code?: string;
  path?: string;
  errno?: number;
  syscall?: string;
}

/** Cast an unknown error to the Node fs-errno shape we partially recognize. */
function asErrno(err: unknown): NodeErrnoLike | null {
  if (err instanceof Error && 'code' in err && typeof (err as NodeErrnoLike).code === 'string') {
    return err as unknown as NodeErrnoLike;
  }
  return null;
}

/**
 * Render an Error (or anything Error-shaped) as a one-line user-facing
 * string. Surfaces actionable hints when the error matches a known
 * pattern; otherwise returns the original message.
 */
export function friendlyError(err: unknown): string {
  if (err === null || err === undefined) return 'Unknown error';
  if (!(err instanceof Error)) {
    if (typeof err === 'string' || typeof err === 'number' || typeof err === 'boolean') {
      return String(err);
    }
    // Avoid `[object Object]` — fall back to JSON for plain throwables.
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  }

  const msg = err.message;
  const errno = asErrno(err);

  if (errno !== null) {
    switch (errno.code) {
      case 'ENOSPC':
        return `Disk full — no space left on the device. Free some space and retry. (${errno.path ?? 'unknown path'})`;
      case 'EACCES':
        return `Permission denied: ${errno.path ?? 'unknown path'}. Check filesystem permissions on the workspace.`;
      case 'EROFS':
        return `Filesystem is read-only: ${errno.path ?? 'unknown path'}. Workspace cannot be mutated.`;
      case 'ENOENT':
        return `File or directory not found: ${errno.path ?? 'unknown path'}.`;
      case 'EISDIR':
        return `Expected a file but found a directory: ${errno.path ?? 'unknown path'}.`;
      case 'EMFILE':
      case 'ENFILE':
        return `Too many open files. Close other ico processes or raise your shell's file-descriptor limit (\`ulimit -n\`).`;
      case 'EBUSY':
        return `Resource busy: ${errno.path ?? 'unknown path'}. Another process may be using it.`;
    }
  }

  // SQLite errors come through better-sqlite3 with `code` like 'SQLITE_BUSY' /
  // 'SQLITE_READONLY' and a descriptive message.
  if (errno?.code === 'SQLITE_BUSY' || msg.toLowerCase().includes('database is locked')) {
    return 'Workspace database is locked — another ico process is using it. Wait and retry.';
  }
  if (errno?.code === 'SQLITE_READONLY') {
    return 'Workspace database is read-only. Check filesystem permissions on `.ico/state.db`.';
  }
  if (errno?.code === 'SQLITE_CORRUPT') {
    return 'Workspace database appears corrupted. Restore from backup or re-init the workspace.';
  }

  // Claude API errors carry their category in the sanitized message.
  if (msg.includes('Claude API authentication_error')) {
    return 'Claude API rejected the credentials. Check ANTHROPIC_API_KEY in your workspace config.';
  }
  if (msg.includes('Claude API rate_limit_error')) {
    return 'Claude API rate limit exceeded. Retry in a few minutes or reduce concurrency.';
  }
  if (msg.includes('Claude API overloaded_error')) {
    return 'Claude API is currently overloaded. Retry in a few minutes.';
  }
  if (msg.includes('Claude API bad_request_error')) {
    return `Claude API rejected the request: ${msg}`;
  }
  if (msg.includes('Claude API server_error')) {
    return 'Claude API server error. The service may be temporarily degraded.';
  }

  return msg;
}
