import { describe, expect, it } from 'vitest';
import { mdfRetrySeconds, MdfNeedsAttention } from './mdf-job-runner';

describe('MDF job retry policy', () => {
  it('retries independently of notifications with bounded backoff', () => {
    expect([1, 2, 3, 4, 5, 20].map(mdfRetrySeconds)).toEqual([5, 15, 60, 300, 300, 300]);
  });
  it('rejects invalid attempts and unsafe diagnostic codes', () => {
    expect(() => mdfRetrySeconds(0)).toThrow();
    expect(() => new MdfNeedsAttention('password=secret')).toThrow('INVALID_MDF_ERROR_CODE');
    expect(new MdfNeedsAttention('MDF_UNRESOLVED_COMPOSITION').code).toBe('MDF_UNRESOLVED_COMPOSITION');
  });
});
