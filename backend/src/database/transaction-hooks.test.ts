import { describe, expect, it } from 'vitest';
import { beginTransactionHooks, beforeTransactionCommit, flushTransactionHooks, discardTransactionHooks } from './transaction-hooks';

describe('transaction finalizers', () => {
  it('runs once, in deterministic order, and deduplicates registration', async () => {
    const tx = {}, calls: string[] = [];
    beginTransactionHooks(tx);
    beforeTransactionCommit(tx, 'z', async () => { calls.push('z'); });
    beforeTransactionCommit(tx, 'a', async () => { calls.push('a'); });
    beforeTransactionCommit(tx, 'a', async () => { calls.push('duplicate'); });
    expect(calls).toEqual([]);
    await flushTransactionHooks(tx);
    expect(calls).toEqual(['a', 'z']);
    await expect(flushTransactionHooks(tx)).rejects.toThrow('TRANSACTION_HOOKS_CLOSED');
    discardTransactionHooks(tx);
  });
  it('never registers outside an owned transaction', () => {
    expect(() => beforeTransactionCommit({}, 'a', async () => {})).toThrow('TRANSACTION_HOOKS_UNAVAILABLE');
  });
  it('discards rollback callbacks and keeps different transactions separate', async () => {
    const a = {}, b = {}, calls: string[] = [];
    beginTransactionHooks(a); beginTransactionHooks(b);
    beforeTransactionCommit(a, 'a', async () => { calls.push('a'); });
    beforeTransactionCommit(b, 'b', async () => { calls.push('b'); });
    discardTransactionHooks(a);
    await flushTransactionHooks(b);
    expect(calls).toEqual(['b']);
    discardTransactionHooks(b);
  });
  it('propagates SQL failure and does not execute remaining callbacks', async () => {
    const tx = {}, calls: string[] = [];
    beginTransactionHooks(tx);
    beforeTransactionCommit(tx, 'a', async () => { throw new Error('sql-failure'); });
    beforeTransactionCommit(tx, 'b', async () => { calls.push('b'); });
    await expect(flushTransactionHooks(tx)).rejects.toThrow('sql-failure');
    expect(calls).toEqual([]);
    discardTransactionHooks(tx);
  });
  it('rejects reentrant registration while flushing', async () => {
    const tx = {};
    beginTransactionHooks(tx);
    beforeTransactionCommit(tx, 'a', async () => {
      beforeTransactionCommit(tx, 'b', async () => {});
    });
    await expect(flushTransactionHooks(tx)).rejects.toThrow('TRANSACTION_HOOKS_CLOSED');
    discardTransactionHooks(tx);
  });
});
