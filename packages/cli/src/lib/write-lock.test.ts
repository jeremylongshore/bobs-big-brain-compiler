import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ico/kernel', () => ({
  withWriteLock: vi.fn(),
}));

import { withWriteLock } from '@ico/kernel';

import {
  BrainWriteLockBusyError,
  isBrainWriteLockBusyError,
  withBrainWriteLock,
} from './write-lock.js';

const mockedWithWriteLock = vi.mocked(withWriteLock);

describe('withBrainWriteLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the callback value and records an acquired lock', async () => {
    mockedWithWriteLock.mockResolvedValue({
      ok: true,
      value: { ran: true, locked: true, value: 'written' },
    });

    const callback = vi.fn(() => 'written');
    const result = await withBrainWriteLock(callback);

    expect(result).toEqual({ ok: true, value: { value: 'written', locked: true } });
    expect(callback).not.toHaveBeenCalled();
    expect(mockedWithWriteLock).toHaveBeenCalledWith(callback);
  });

  it('turns contention into a retryable error without running the callback', async () => {
    mockedWithWriteLock.mockResolvedValue({
      ok: true,
      value: { ran: false, locked: true },
    });

    const callback = vi.fn(() => 'must-not-run');
    const result = await withBrainWriteLock(callback);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BrainWriteLockBusyError);
    expect(isBrainWriteLockBusyError(result.error)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('preserves the kernel degraded-mode signal', async () => {
    mockedWithWriteLock.mockResolvedValue({
      ok: true,
      value: { ran: true, locked: false, value: 'degraded' },
    });

    const result = await withBrainWriteLock(() => 'degraded');

    expect(result).toEqual({ ok: true, value: { value: 'degraded', locked: false } });
  });

  it('propagates kernel errors', async () => {
    const error = new Error('spawn failed');
    mockedWithWriteLock.mockResolvedValue({ ok: false, error });

    const result = await withBrainWriteLock(() => 'unreachable');

    expect(result).toEqual({ ok: false, error });
  });
});
