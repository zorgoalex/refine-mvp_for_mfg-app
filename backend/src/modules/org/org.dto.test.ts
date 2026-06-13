import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import {
  parseCreateDirectionRequest,
  parseUpdateDirectionRequest,
  parseReplaceIdSetRequest,
  parseDeleteConfirmation,
} from './org.dto';

describe('org DTO validation', () => {
  it('parses a valid create request and trims the name', () => {
    expect(parseCreateDirectionRequest({ name: '  Покраска  ' }))
      .toEqual({ name: 'Покраска', description: null, isActive: true });
  });

  it('rejects an empty direction name', () => {
    expect(() => parseCreateDirectionRequest({ name: '   ' })).toThrow(ApiError);
  });

  it('rejects an over-long name (>128)', () => {
    expect(() => parseCreateDirectionRequest({ name: 'x'.repeat(129) })).toThrow(ApiError);
  });

  it('parses a replace-id-set request and dedupes + sorts ids', () => {
    expect(parseReplaceIdSetRequest({ idempotencyKey: 'k1', ids: [3, 1, 3] }))
      .toEqual({ idempotencyKey: 'k1', ids: [1, 3], reason: null });
  });

  it('rejects a replace request missing the idempotency key', () => {
    expect(() => parseReplaceIdSetRequest({ ids: [1] })).toThrow(ApiError);
  });

  it('rejects non-positive-integer ids', () => {
    expect(() => parseReplaceIdSetRequest({ idempotencyKey: 'k', ids: [0] })).toThrow(ApiError);
    expect(() => parseReplaceIdSetRequest({ idempotencyKey: 'k', ids: [1.5] })).toThrow(ApiError);
  });

  it('allows an empty id set (clears membership/heads)', () => {
    expect(parseReplaceIdSetRequest({ idempotencyKey: 'k', ids: [] }))
      .toEqual({ idempotencyKey: 'k', ids: [], reason: null });
  });

  it('parses an update with only the fields provided', () => {
    expect(parseUpdateDirectionRequest({ isActive: false })).toEqual({ isActive: false });
  });

  it('rejects an empty update', () => {
    expect(() => parseUpdateDirectionRequest({})).toThrow(ApiError);
  });

  it('accepts confirm=true and rejects a bare/absent confirm for hard delete', () => {
    expect(() => parseDeleteConfirmation('true')).not.toThrow();
    expect(() => parseDeleteConfirmation(true)).not.toThrow();
    expect(() => parseDeleteConfirmation(undefined)).toThrow(ApiError);
    expect(() => parseDeleteConfirmation('false')).toThrow(ApiError);
  });
});
