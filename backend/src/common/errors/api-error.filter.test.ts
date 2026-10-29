import { describe, expect, it } from 'vitest';
import { clientMergedError } from './api-error.filter';

describe('a write referencing a merged client', () => {
  it('becomes 409 CLIENT_MERGED with the client to use instead', () => {
    const error = clientMergedError({ code: '23514', constraint: 'chk_client_not_merged', detail: 'merged_client_id=12 survivor_id=7' });
    expect(error).toMatchObject({ statusCode: 409, code: 'CLIENT_MERGED', details: { mergedClientId: 12, survivorId: 7 } });
  });

  it('leaves other errors alone', () => {
    expect(clientMergedError({ code: '23514', constraint: 'chk_other' })).toBeNull();
    expect(clientMergedError(new Error('boom'))).toBeNull();
    expect(clientMergedError(null)).toBeNull();
  });
});
