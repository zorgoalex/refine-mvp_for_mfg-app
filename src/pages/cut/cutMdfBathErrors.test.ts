import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import { buildMdfBathErrorView, createSingleFlight, isDefinitiveCalculationRejection, isMdfBathErrorCode, MDF_BATH_ERROR_CODES } from './cutMdfBathErrors';

function apiError(code: string, message = '', status = 409): ApiError {
  return new ApiError({ code, message, status });
}

describe('isMdfBathErrorCode', () => {
  it('recognizes exactly the MDF-bath lifecycle codes', () => {
    for (const code of MDF_BATH_ERROR_CODES) {
      expect(isMdfBathErrorCode(code)).toBe(true);
    }
    expect(isMdfBathErrorCode('CUT_STALE_VERSION')).toBe(false);
    expect(isMdfBathErrorCode('CUT_RESULT_ARCHIVED')).toBe(false);
    expect(isMdfBathErrorCode(undefined)).toBe(false);
    expect(isMdfBathErrorCode(42)).toBe(false);
  });
});

describe('buildMdfBathErrorView', () => {
  it('returns null for a non-ApiError', () => {
    expect(buildMdfBathErrorView(new Error('boom'))).toBeNull();
    expect(buildMdfBathErrorView(null)).toBeNull();
    expect(buildMdfBathErrorView(undefined)).toBeNull();
  });

  it('returns null for an ApiError with an unrelated code', () => {
    expect(buildMdfBathErrorView(apiError('CUT_STALE_VERSION', 'stale'))).toBeNull();
    expect(buildMdfBathErrorView(apiError('CUT_RESULT_ARCHIVED', 'archived'))).toBeNull();
  });

  it('passes through the backend Russian message unchanged', () => {
    const view = buildMdfBathErrorView(
      apiError('MDF_BATH_HAS_PRODUCTION', 'Ванна уже закатана — сначала оформите возврат закатки'),
    );
    expect(view).toEqual({
      code: 'MDF_BATH_HAS_PRODUCTION',
      message: 'Ванна уже закатана — сначала оформите возврат закатки',
      reload: false,
    });
  });

  it('falls back to a Russian message when the backend message is missing', () => {
    const view = buildMdfBathErrorView(apiError('MDF_BATH_TRANSITION_PENDING', ''));
    expect(view?.message).toBe('Предыдущее изменение ванны ещё обрабатывается — повторите позже');
    expect(view?.reload).toBe(false);
  });

  it('marks only CUT_JOB_STALE_VERSION and MDF_BATH_LIFECYCLE_STALE as reload-worthy', () => {
    expect(buildMdfBathErrorView(apiError('CUT_JOB_STALE_VERSION', 'Задание раскроя изменилось — обновите страницу'))?.reload).toBe(true);
    expect(buildMdfBathErrorView(apiError('MDF_BATH_LIFECYCLE_STALE', 'Раскрой изменился — обновите страницу и повторите'))?.reload).toBe(true);

    for (const code of [
      'MDF_BATH_HAS_PRODUCTION',
      'MDF_BATH_TRANSITION_PENDING',
      'MDF_BATH_RESULT_RETIRED',
      'MDF_BATH_SUCCESSOR_INVALID',
      'MDF_ENGINE_READ_ONLY',
      'MDF_BATH_FENCE_REQUIRED',
    ]) {
      expect(buildMdfBathErrorView(apiError(code, 'msg'))?.reload).toBe(false);
    }
  });

  it('covers every documented code with a distinct fallback message', () => {
    const messages = new Set<string>();
    for (const code of MDF_BATH_ERROR_CODES) {
      const view = buildMdfBathErrorView(apiError(code, ''));
      expect(view).not.toBeNull();
      expect(view!.code).toBe(code);
      messages.add(view!.message);
    }
    // CUT_JOB_STALE_VERSION and MDF_BATH_LIFECYCLE_STALE intentionally share
    // the same "reload" copy; every other code has a distinct message.
    expect(messages.size).toBe(MDF_BATH_ERROR_CODES.length - 1);
  });
});

describe('isDefinitiveCalculationRejection', () => {
  it('treats every MDF bath rejection and the settled cut codes as definitive', () => {
    for (const code of MDF_BATH_ERROR_CODES) expect(isDefinitiveCalculationRejection(apiError(code))).toBe(true);
    for (const code of ['CUT_STALE_VERSION', 'CUT_RESULT_COMMAND_CONFLICT', 'CUT_RESULT_COMMAND_FAILED',
      'CUT_RESULT_COMMAND_ABANDONED', 'CUT_JOB_NOT_MUTABLE']) {
      expect(isDefinitiveCalculationRejection(apiError(code))).toBe(true);
    }
  });

  it('keeps ambiguous failures retryable (transport errors, unknown or server-side codes)', () => {
    expect(isDefinitiveCalculationRejection(new TypeError('Failed to fetch'))).toBe(false);
    expect(isDefinitiveCalculationRejection(apiError('INTERNAL_ERROR', '', 500))).toBe(false);
    expect(isDefinitiveCalculationRejection(null)).toBe(false);
  });
});

describe('createSingleFlight', () => {
  it('runs exactly one calculation for overlapping clicks, even while the first awaits a refresh', async () => {
    const flight = createSingleFlight();
    let releaseRefresh!: () => void;
    const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const commands: string[] = [];
    const click = (id: string) => flight(async () => { await refresh; commands.push(id); return id; });
    const first = click('first');
    const second = click('second');
    releaseRefresh();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBeUndefined();
    expect(commands).toEqual(['first']);
    // After completion a new click runs again.
    await expect(flight(async () => 'third')).resolves.toBe('third');
  });

  it('releases the gate when the run throws', async () => {
    const flight = createSingleFlight();
    await expect(flight(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(flight(async () => 'ok')).resolves.toBe('ok');
  });
});

