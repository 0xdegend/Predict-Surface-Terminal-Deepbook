import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the MemWal SDK so the wrapper's choice of call is observable without touching
// the live relayer. Hoisted so the vi.mock factory can close over the same fns.
const { remember, waitForRememberJob, rememberAndWait } = vi.hoisted(() => ({
  remember: vi.fn(),
  waitForRememberJob: vi.fn(),
  rememberAndWait: vi.fn(),
}));

vi.mock('@mysten-incubation/memwal', () => ({
  MemWal: { create: () => ({ remember, waitForRememberJob, rememberAndWait }) },
}));

beforeEach(() => {
  process.env.WALRUS_DELEGATE_KEY = 'deadbeef';
  process.env.WALRUS_MEMORY_ACCOUNT_ID = '0xacc';
  remember.mockReset();
  waitForRememberJob.mockReset();
  rememberAndWait.mockReset();
});

describe('rememberForUser — instant accept-and-return', () => {
  it('uses the non-blocking remember(), never the blocking rememberAndWait()', async () => {
    remember.mockResolvedValue({ job_id: 'job-1', status: 'pending' });
    const { rememberForUser } = await import('./memory');

    const r = await rememberForUser('0xABC', 'your name is Degendev');

    // Namespaced per wallet, lowercased.
    expect(remember).toHaveBeenCalledWith('your name is Degendev', 'kelly.v2:0xabc');
    // The old 10-30s blocker must not be on the reply path anymore.
    expect(rememberAndWait).not.toHaveBeenCalled();
    // Does not wait on the background pipeline before returning.
    expect(waitForRememberJob).not.toHaveBeenCalled();
    expect(r).toEqual({ id: 'job-1', status: 'pending' });
  });
});

describe('confirmRememberForUser — best-effort, never throws', () => {
  it('polls the job to its terminal state and resolves quietly on success', async () => {
    waitForRememberJob.mockResolvedValue({
      id: 'job-1',
      blob_id: 'blob',
      owner: '0xabc',
      namespace: 'kelly.v2:0xabc',
    });
    const { confirmRememberForUser } = await import('./memory');

    await expect(confirmRememberForUser('job-1', '0xabc')).resolves.toBeUndefined();
    expect(waitForRememberJob).toHaveBeenCalledWith('job-1', { timeoutMs: 150_000 });
  });

  it('swallows a failed or timed-out job (logs, does not throw)', async () => {
    waitForRememberJob.mockRejectedValue(new Error('timeout'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { confirmRememberForUser } = await import('./memory');

    await expect(confirmRememberForUser('job-x', '0xabc')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
