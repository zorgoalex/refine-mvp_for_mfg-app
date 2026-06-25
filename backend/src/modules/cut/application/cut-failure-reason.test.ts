import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  describeCutFailure,
  extractCutFailureStatus,
  shouldMarkCutFailed,
  CUT_FAILURE_FALLBACK_CODE,
} from './cut-failure-reason';

describe('describeCutFailure', () => {
  it('maps FREECUT_CONSTRAINT_ERROR to a placement-overflow Russian reason', () => {
    const info = describeCutFailure(new ApiError(422, 'FREECUT_CONSTRAINT_ERROR', 'freecut responded with 422'));
    expect(info.code).toBe('FREECUT_CONSTRAINT_ERROR');
    expect(info.reason).toMatch(/не помещаются на лист/i);
  });

  it('maps FREECUT_REQUEST_TOO_LARGE to a "too many details / split" reason', () => {
    const info = describeCutFailure(new ApiError(413, 'FREECUT_REQUEST_TOO_LARGE', 'too large'));
    expect(info.code).toBe('FREECUT_REQUEST_TOO_LARGE');
    expect(info.reason).toMatch(/слишком много деталей/i);
  });

  it('maps FREECUT_VALIDATION_ERROR to an invalid-input reason', () => {
    const info = describeCutFailure(new ApiError(422, 'FREECUT_VALIDATION_ERROR', 'bad input'));
    expect(info.code).toBe('FREECUT_VALIDATION_ERROR');
    expect(info.reason).toMatch(/некорректные данные/i);
  });

  it('maps FREECUT_TIMEOUT to a retry-later timeout reason', () => {
    const info = describeCutFailure(new ApiError(504, 'FREECUT_TIMEOUT', 'timed out'));
    expect(info.code).toBe('FREECUT_TIMEOUT');
    expect(info.reason).toMatch(/не успел|время/i);
  });

  it('maps FREECUT_OVERLOADED to an overloaded reason', () => {
    const info = describeCutFailure(new ApiError(503, 'FREECUT_OVERLOADED', 'busy'));
    expect(info.code).toBe('FREECUT_OVERLOADED');
    expect(info.reason).toMatch(/перегружен/i);
  });

  it('maps FREECUT_PROVIDER_ERROR to an unavailable reason', () => {
    const info = describeCutFailure(new ApiError(502, 'FREECUT_PROVIDER_ERROR', 'provider down'));
    expect(info.code).toBe('FREECUT_PROVIDER_ERROR');
    expect(info.reason).toMatch(/недоступен/i);
  });

  it('falls back to a generic reason + sentinel code for an unknown ApiError code', () => {
    const info = describeCutFailure(new ApiError(500, 'SOME_OTHER_CODE', 'weird'));
    expect(info.code).toBe(CUT_FAILURE_FALLBACK_CODE);
    expect(info.reason).toMatch(/внутренней ошибки|повторите/i);
  });

  it('falls back for a non-ApiError (plain Error) without throwing', () => {
    const info = describeCutFailure(new Error('boom'));
    expect(info.code).toBe(CUT_FAILURE_FALLBACK_CODE);
    expect(info.reason).toMatch(/повторите/i);
  });

  it('falls back for a null/undefined error', () => {
    const info = describeCutFailure(undefined);
    expect(info.code).toBe(CUT_FAILURE_FALLBACK_CODE);
    expect(typeof info.reason).toBe('string');
    expect(info.reason.length).toBeGreaterThan(0);
  });

  it('recognises a plain object carrying a known string code (duck-typed)', () => {
    const info = describeCutFailure({ code: 'FREECUT_TIMEOUT' });
    expect(info.code).toBe('FREECUT_TIMEOUT');
    expect(info.reason).toMatch(/не успел|время/i);
  });

  it('maps Phase 1 cut-domain codes to operator reasons', () => {
    expect(describeCutFailure(new ApiError(422, 'CUT_NO_ITEMS', 'x')).reason).toMatch(/нет деталей/i);
    expect(describeCutFailure(new ApiError(422, 'CUT_NO_SHEET_SPEC', 'x')).reason).toMatch(/раскройной спецификации/i);
    expect(describeCutFailure(new ApiError(413, 'CUT_REQUEST_TOO_LARGE', 'x')).reason).toMatch(/слишком много деталей/i);
    expect(describeCutFailure(new ApiError(422, 'CUT_MAX_INSTANCES_EXCEEDED', 'x')).reason).toMatch(/слишком много деталей/i);
    expect(describeCutFailure(new ApiError(422, 'CUT_INVALID_GRAIN_RULE', 'x')).reason).toMatch(/текстуры|grain/i);
  });
});

describe('shouldMarkCutFailed', () => {
  it('returns false for precondition/concurrency codes (do not mark failed)', () => {
    for (const code of ['CUT_STALE_VERSION', 'CUT_JOB_NOT_MUTABLE', 'CUT_JOB_NOT_FOUND', 'PERMISSION_DENIED']) {
      expect(shouldMarkCutFailed(new ApiError(409, code, 'x'))).toBe(false);
    }
  });

  it('returns false for CUT_PARAM_PROFILE_NOT_FOUND (precondition: operator must fix profile selection)', () => {
    expect(shouldMarkCutFailed(new ApiError(422, 'CUT_PARAM_PROFILE_NOT_FOUND', 'chosen profile is inactive'))).toBe(false);
  });

  it('returns false for CUT_SHEET_MATERIAL_NOT_CUTTABLE (precondition: chosen sheet deactivated after selection)', () => {
    expect(shouldMarkCutFailed(new ApiError(422, 'CUT_SHEET_MATERIAL_NOT_CUTTABLE', 'chosen sheet is inactive'))).toBe(false);
  });

  it('returns true for genuine calculation failures (freecut + cut validation)', () => {
    expect(shouldMarkCutFailed(new ApiError(504, 'FREECUT_TIMEOUT', 'x'))).toBe(true);
    expect(shouldMarkCutFailed(new ApiError(422, 'CUT_NO_ITEMS', 'x'))).toBe(true);
    expect(shouldMarkCutFailed(new Error('boom'))).toBe(true);
    expect(shouldMarkCutFailed(undefined)).toBe(true);
  });
});

describe('extractCutFailureStatus', () => {
  it('reads statusCode off an ApiError', () => {
    expect(extractCutFailureStatus(new ApiError(422, 'X', 'm'))).toBe(422);
  });

  it('duck-types a plain object statusCode or status', () => {
    expect(extractCutFailureStatus({ statusCode: 413 })).toBe(413);
    expect(extractCutFailureStatus(Object.assign(new Error('x'), { status: 504 }))).toBe(504);
  });

  it('falls back to 500 for an unknown/malformed error', () => {
    expect(extractCutFailureStatus(new Error('x'))).toBe(500);
    expect(extractCutFailureStatus(undefined)).toBe(500);
    expect(extractCutFailureStatus({ status: 'nope' })).toBe(500);
  });
});
