import { describe, expect, it, vi } from 'vitest';
import { CutPdfCache } from './cut-pdf-cache';

describe('CutPdfCache', () => {
  it('returns pending on a cold miss, then ready after the render settles', async () => {
    const cache = new CutPdfCache({ ttlMs: 1000 });
    const render = vi.fn().mockResolvedValue(Buffer.from('%PDF-1'));

    const first = cache.ensure('k', render);
    expect(first.status).toBe('pending');

    await cache.whenIdle();

    const second = cache.ensure('k', render);
    expect(second.status).toBe('ready');
    if (second.status === 'ready') expect(second.buffer.toString('latin1')).toBe('%PDF-1');
    // Rendered exactly once (cache hit on the second call).
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent renders for the same key (in-flight guard)', async () => {
    const cache = new CutPdfCache({ ttlMs: 1000 });
    const render = vi.fn().mockResolvedValue(Buffer.from('x'));

    expect(cache.ensure('k', render).status).toBe('pending');
    expect(cache.ensure('k', render).status).toBe('pending');
    await cache.whenIdle();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-renders after the TTL expires', async () => {
    let nowMs = 1_000_000;
    const cache = new CutPdfCache({ ttlMs: 1000, now: () => nowMs });
    const render = vi.fn().mockResolvedValue(Buffer.from('x'));

    cache.ensure('k', render);
    await cache.whenIdle();
    expect(cache.ensure('k', render).status).toBe('ready');

    nowMs += 1001; // past TTL
    expect(cache.ensure('k', render).status).toBe('pending');
    await cache.whenIdle();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entries once maxEntries is exceeded (bounded memory)', async () => {
    const cache = new CutPdfCache({ ttlMs: 100000, maxEntries: 2 });
    for (const k of ['a', 'b', 'c']) {
      cache.ensure(k, () => Promise.resolve(Buffer.from(k)));
      await cache.whenIdle();
    }
    // 'a' was evicted (FIFO) when 'c' landed; 'b' and 'c' remain warm.
    expect(cache.ensure('a', () => Promise.resolve(Buffer.from('a'))).status).toBe('pending');
    expect(cache.ensure('b', () => Promise.resolve(Buffer.from('b'))).status).toBe('ready');
    expect(cache.ensure('c', () => Promise.resolve(Buffer.from('c'))).status).toBe('ready');
  });

  it('surfaces a deterministic render failure on retry (no 202-forever loop)', async () => {
    let nowMs = 1_000_000;
    const cache = new CutPdfCache({ ttlMs: 1000, failureTtlMs: 5000, now: () => nowMs });
    const boom = new Error('empty group');
    const render = vi.fn().mockRejectedValue(boom);

    expect(cache.ensure('k', render).status).toBe('pending');
    await cache.whenIdle();

    // Within the failure window the error is surfaced (endpoint returns 4xx/5xx),
    // and NO new render is kicked.
    const failed = cache.ensure('k', render);
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') expect(failed.error).toBe(boom);
    expect(render).toHaveBeenCalledTimes(1);

    // After the failure TTL it retries.
    nowMs += 5001;
    expect(cache.ensure('k', render).status).toBe('pending');
    await cache.whenIdle();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('invokes onSettled("ready") on success and onSettled("failed", reason) on error', async () => {
    const cache = new CutPdfCache({ ttlMs: 1000 });
    const ok = vi.fn();
    cache.ensure('ok', () => Promise.resolve(Buffer.from('x')), ok);
    await cache.whenIdle();
    expect(ok).toHaveBeenCalledWith('ready', undefined);

    const bad = vi.fn();
    cache.ensure('bad', () => Promise.reject(new Error('boom')), bad);
    await cache.whenIdle();
    expect(bad).toHaveBeenCalledWith('failed', 'boom');
    // The failure is briefly remembered so a retry surfaces the error.
    expect(cache.ensure('bad', () => Promise.resolve(Buffer.from('y'))).status).toBe('failed');
  });
});
