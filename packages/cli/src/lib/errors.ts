/**
 * Typed error classes and CLI-boundary error handler for the ico CLI.
 *
 * Every exported error class extends {@link IcoError}, which carries a
 * human-readable `resolution` hint and a machine-readable `code` string so
 * that callers and tests can discriminate errors without parsing messages.
 *
 * The {@link handleError} function is the single exit point for unhandled
 * errors — it formats the message, optionally prints a stack trace (verbose
 * mode), and calls `process.exit(1)`.
 *
 * @module errors
 */

import { formatError } from './output.js';

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * Base class for all ico CLI errors.
 *
 * @param message    - Short, human-readable description of what went wrong.
 * @param resolution - Actionable hint for how the user can fix the problem.
 * @param code       - Machine-readable error identifier (e.g. `ERR_NO_WORKSPACE`).
 */
export class IcoError extends Error {
  constructor(
    message: string,
    public readonly resolution: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'IcoError';
  }
}

// ---------------------------------------------------------------------------
// Concrete error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when no workspace directory can be located.
 *
 * @param path - Optional filesystem path that was searched. When omitted the
 *               message is generic.
 */
export class WorkspaceNotFoundError extends IcoError {
  constructor(path?: string) {
    super(
      path ? `No workspace found at "${path}"` : 'No workspace found',
      "Run 'ico init <name>' to create a workspace, or use --workspace to specify a path.",
      'ERR_NO_WORKSPACE',
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Thrown when a workspace database operation fails.
 *
 * @param message - Description of the database failure.
 */
export class DatabaseError extends IcoError {
  constructor(message: string) {
    super(
      message,
      'The workspace database may be corrupted. Try reinitializing with ico init.',
      'ERR_DATABASE',
    );
    this.name = 'DatabaseError';
  }
}

/**
 * Thrown when a required file cannot be found on disk.
 *
 * @param path - Absolute or relative path that was not found.
 */
export class FileNotFoundError extends IcoError {
  constructor(path: string) {
    super(`File not found: "${path}"`, 'Check the path and try again.', 'ERR_FILE_NOT_FOUND');
    this.name = 'FileNotFoundError';
  }
}

/**
 * Thrown when a required environment variable or configuration value is absent.
 *
 * Provides a specific resolution hint for `ANTHROPIC_API_KEY`; all other
 * variables receive a generic prompt.
 *
 * @param variable - Name of the missing environment variable.
 */
export class ConfigError extends IcoError {
  constructor(variable: string) {
    super(
      `Missing configuration: ${variable}`,
      variable === 'ANTHROPIC_API_KEY'
        ? 'Set ANTHROPIC_API_KEY in your environment or .env file.'
        : `Set ${variable} in your environment or .env file.`,
      'ERR_CONFIG',
    );
    this.name = 'ConfigError';
  }
}

/**
 * Thrown when user-supplied input fails validation.
 *
 * @param message    - Description of the validation failure.
 * @param resolution - Optional custom resolution hint; defaults to a generic
 *                     "check the input" message.
 */
export class ValidationError extends IcoError {
  constructor(message: string, resolution?: string) {
    super(message, resolution ?? 'Check the input and try again.', 'ERR_VALIDATION');
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// CLI-boundary error handler
// ---------------------------------------------------------------------------

/**
 * Handle an unknown error at the CLI boundary.
 *
 * - {@link IcoError} instances print `message` + `resolution`.
 * - Plain `Error` instances print `message` only.
 * - All other values are coerced to a string via `String()`.
 * - When `verbose` is `true`, the full stack trace is printed after the
 *   formatted message (when available).
 *
 * Always terminates the process with exit code `1`.
 *
 * @param error   - The caught value (may be anything).
 * @param verbose - When `true`, print the stack trace.
 * @returns       Never returns — always exits.
 */
export function handleError(error: unknown, verbose?: boolean): never {
  if (error instanceof IcoError) {
    console.error(formatError(error.message));
    console.error(`  ${error.resolution}`);
    if (verbose === true && error.stack !== undefined) {
      console.error(`\n${error.stack}`);
    }
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(formatError(error.message));
    if (verbose === true && error.stack !== undefined) {
      console.error(`\n${error.stack}`);
    }
    process.exit(1);
  }

  console.error(formatError(String(error)));
  process.exit(1);
}
