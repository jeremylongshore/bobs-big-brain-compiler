import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  ConfigError,
  DatabaseError,
  FileNotFoundError,
  handleError,
  IcoError,
  ValidationError,
  WorkspaceNotFoundError,
} from './errors.js';

// ---------------------------------------------------------------------------
// WorkspaceNotFoundError
// ---------------------------------------------------------------------------

describe('WorkspaceNotFoundError', () => {
  it('has a generic message when no path is given', () => {
    const err = new WorkspaceNotFoundError();
    expect(err.message).toBe('No workspace found');
  });

  it('includes the path in the message when one is provided', () => {
    const err = new WorkspaceNotFoundError('/some/path');
    expect(err.message).toBe('No workspace found at "/some/path"');
  });

  it('has the correct resolution hint', () => {
    const err = new WorkspaceNotFoundError();
    expect(err.resolution).toContain('ico init');
    expect(err.resolution).toContain('--workspace');
  });

  it('has the correct error code', () => {
    expect(new WorkspaceNotFoundError().code).toBe('ERR_NO_WORKSPACE');
  });

  it('extends IcoError', () => {
    expect(new WorkspaceNotFoundError()).toBeInstanceOf(IcoError);
  });
});

// ---------------------------------------------------------------------------
// DatabaseError
// ---------------------------------------------------------------------------

describe('DatabaseError', () => {
  it('uses the provided message', () => {
    const err = new DatabaseError('disk full');
    expect(err.message).toBe('disk full');
  });

  it('has the correct error code', () => {
    expect(new DatabaseError('x').code).toBe('ERR_DATABASE');
  });

  it('resolution mentions reinitializing', () => {
    const err = new DatabaseError('x');
    expect(err.resolution).toContain('ico init');
  });

  it('extends IcoError', () => {
    expect(new DatabaseError('x')).toBeInstanceOf(IcoError);
  });
});

// ---------------------------------------------------------------------------
// FileNotFoundError
// ---------------------------------------------------------------------------

describe('FileNotFoundError', () => {
  it('includes the path in the message', () => {
    const err = new FileNotFoundError('/tmp/missing.txt');
    expect(err.message).toContain('/tmp/missing.txt');
  });

  it('has the correct error code', () => {
    expect(new FileNotFoundError('/x').code).toBe('ERR_FILE_NOT_FOUND');
  });

  it('extends IcoError', () => {
    expect(new FileNotFoundError('/x')).toBeInstanceOf(IcoError);
  });
});

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

describe('ConfigError', () => {
  it('gives a specific resolution for ANTHROPIC_API_KEY', () => {
    const err = new ConfigError('ANTHROPIC_API_KEY');
    expect(err.resolution).toBe('Set ANTHROPIC_API_KEY in your environment or .env file.');
  });

  it('gives a generic resolution for other variables', () => {
    const err = new ConfigError('MY_CUSTOM_VAR');
    expect(err.resolution).toBe('Set MY_CUSTOM_VAR in your environment or .env file.');
  });

  it('includes the variable name in the message', () => {
    const err = new ConfigError('MY_VAR');
    expect(err.message).toContain('MY_VAR');
  });

  it('has the correct error code', () => {
    expect(new ConfigError('X').code).toBe('ERR_CONFIG');
  });

  it('extends IcoError', () => {
    expect(new ConfigError('X')).toBeInstanceOf(IcoError);
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('uses a custom resolution when provided', () => {
    const err = new ValidationError('bad input', 'Use a valid date.');
    expect(err.resolution).toBe('Use a valid date.');
  });

  it('falls back to a generic resolution when none is provided', () => {
    const err = new ValidationError('bad input');
    expect(err.resolution).toBe('Check the input and try again.');
  });

  it('has the correct error code', () => {
    expect(new ValidationError('x').code).toBe('ERR_VALIDATION');
  });

  it('extends IcoError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(IcoError);
  });
});

// ---------------------------------------------------------------------------
// handleError
// ---------------------------------------------------------------------------

describe('handleError', () => {
  let exitSpy: MockInstance;
  let stderrSpy: MockInstance;

  function getStderrOutput(): string[] {
    return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('prints the message and resolution for an IcoError', () => {
    const err = new WorkspaceNotFoundError('/path/to/ws');

    expect(() => handleError(err)).toThrow('process.exit called');

    const output = getStderrOutput();
    expect(output.some((s) => s.includes('No workspace found at "/path/to/ws"'))).toBe(true);
    expect(output.some((s) => s.includes(err.resolution))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints only the message for a plain Error', () => {
    const err = new Error('plain failure');

    expect(() => handleError(err)).toThrow('process.exit called');

    const output = getStderrOutput();
    expect(output.some((s) => s.includes('plain failure'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows the stack trace in verbose mode for an IcoError', () => {
    const err = new WorkspaceNotFoundError();

    expect(() => handleError(err, true)).toThrow('process.exit called');

    const output = getStderrOutput();
    expect(output.some((s) => s.includes('WorkspaceNotFoundError'))).toBe(true);
  });

  it('shows the stack trace in verbose mode for a plain Error', () => {
    const err = new Error('verbose plain');

    expect(() => handleError(err, true)).toThrow('process.exit called');

    const output = getStderrOutput();
    expect(output.some((s) => s.includes('Error'))).toBe(true);
  });

  it('does NOT show the stack trace when verbose is false', () => {
    const err = new WorkspaceNotFoundError();

    expect(() => handleError(err, false)).toThrow('process.exit called');

    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error thrown values', () => {
    expect(() => handleError('just a string')).toThrow('process.exit called');

    const output = getStderrOutput();
    expect(output.some((s) => s.includes('just a string'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// instanceof checks for all error subclasses
// ---------------------------------------------------------------------------

describe('all error subclasses extend IcoError', () => {
  it('WorkspaceNotFoundError instanceof IcoError', () => {
    expect(new WorkspaceNotFoundError()).toBeInstanceOf(IcoError);
  });

  it('DatabaseError instanceof IcoError', () => {
    expect(new DatabaseError('x')).toBeInstanceOf(IcoError);
  });

  it('FileNotFoundError instanceof IcoError', () => {
    expect(new FileNotFoundError('/x')).toBeInstanceOf(IcoError);
  });

  it('ConfigError instanceof IcoError', () => {
    expect(new ConfigError('X')).toBeInstanceOf(IcoError);
  });

  it('ValidationError instanceof IcoError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(IcoError);
  });
});
