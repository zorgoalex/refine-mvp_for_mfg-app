import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import type { Broadcast, BroadcastRunDetail } from '../../../../api/broadcastsApiTypes';
import {
  broadcastErrorMessage,
  buildSaveRequest,
  canCreateBroadcast,
  canRetryAll,
  canRetryRemaining,
  clearPendingReplan,
  clearPendingRetry,
  clearPendingManualSend,
  defaultFormValues,
  draftMatchesSaved,
  insertCaptionVariable,
  isKnownNotCreatedCommandError,
  isKnownNotQueuedError,
  offsetLabel,
  pendingManualSendKey,
  persistPendingManualSend,
  persistPendingReplan,
  persistPendingRetry,
  readPendingManualSend,
  readPendingReplan,
  readPendingRetry,
  runPendingCommand,
  toFormValues,
  validateDeadline,
  validateGroupId,
  validateWeekdays,
  validateWindow,
  weekdaysLabel,
} from './broadcastModel';

const UUID = '11111111-1111-4111-8111-111111111111';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function apiError(code: string, status = 409) {
  return new ApiError({ code, message: 'x', status });
}

const saved: Broadcast = {
  id: 5, version: 3, archived: false, scheduleGeneration: 1, createdAt: '', updatedAt: '', updatedBy: null,
  name: 'Утро', enabled: true, groupChatId: '123456789@g.us', weekdays: [1, 3, 5], sendTime: '08:45',
  sendWindowMinutes: 15, catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00', partialPolicy: 'remaining',
  orderDateOffsetDays: 1, cardsPerMessage: 2, captionTemplate: '',
};

describe('labels', () => {
  it('formats weekdays', () => {
    expect(weekdaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Ежедневно');
    expect(weekdaysLabel([5, 4, 3, 2, 1])).toBe('Пн–Пт');
    expect(weekdaysLabel([1, 3, 7])).toBe('Пн, Ср, Вс');
    expect(weekdaysLabel([])).toBe('—');
  });

  it('formats order-date offsets', () => {
    expect(offsetLabel(0)).toBe('сегодня');
    expect(offsetLabel(1)).toBe('завтра');
    expect(offsetLabel(2)).toBe('послезавтра');
    expect(offsetLabel(3)).toBe('через 3 дня');
    expect(offsetLabel(5)).toBe('через 5 дней');
    expect(offsetLabel(11)).toBe('через 11 дней');
    expect(offsetLabel(14)).toBe('через 14 дней');
  });
});

describe('validators', () => {
  it('validates group ids', () => {
    expect(validateGroupId('', false)).toBeNull();
    expect(validateGroupId('', true)).not.toBeNull();
    expect(validateGroupId('12345-67890@g.us', true)).toBeNull();
    expect(validateGroupId('abc@g.us', false)).not.toBeNull();
  });

  it('keeps the window before midnight and the deadline after the window', () => {
    expect(validateWindow('23:00', 60)).not.toBeNull();
    expect(validateWindow('23:00', 59)).toBeNull();
    expect(validateWindow('08:00', 1440)).not.toBeNull();
    expect(validateDeadline('09:00', '08:45', 30)).not.toBeNull();
    expect(validateDeadline('09:15', dayjs().hour(8).minute(45), 30)).toBeNull();
  });

  it('requires a weekday only when enabled', () => {
    expect(validateWeekdays([], true)).not.toBeNull();
    expect(validateWeekdays([], false)).toBeNull();
    expect(validateWeekdays([1], true)).toBeNull();
  });
});

describe('save payload', () => {
  it('create carries no version, update carries the loaded version', () => {
    const values = { ...defaultFormValues(), name: '  Новая  ', groupChatId: ' 123456789@g.us ' };
    const create = buildSaveRequest(null, values, false);
    expect(create.kind).toBe('create');
    expect(create.body).not.toHaveProperty('version');
    expect(create.body.name).toBe('Новая');
    expect(create.body.groupChatId).toBe('123456789@g.us');
    expect(create.body.weekdays).toEqual([1, 2, 3, 4, 5]);

    const update = buildSaveRequest(saved, toFormValues(saved), false);
    expect(update).toMatchObject({ kind: 'update', id: 5, body: { version: 3, sendTime: '08:45', catchUpDeadline: '10:00' } });
  });

  it('only marks duplicate risk confirmed for repeat_all when the operator agreed', () => {
    const values = { ...toFormValues(saved), partialPolicy: 'repeat_all' as const };
    expect(buildSaveRequest(saved, values, false).body.duplicateRiskConfirmed).toBe(false);
    expect(buildSaveRequest(saved, values, true).body.duplicateRiskConfirmed).toBe(true);
    expect(buildSaveRequest(saved, toFormValues(saved), false).body.duplicateRiskConfirmed).toBe(true);
  });

  it('detects dirty drafts', () => {
    expect(draftMatchesSaved(toFormValues(saved), saved)).toBe(true);
    expect(draftMatchesSaved({ ...toFormValues(saved), weekdays: [1] }, saved)).toBe(false);
  });
});

describe('caption variables', () => {
  it('inserts at the cursor and replaces a selection', () => {
    expect(insertCaptionVariable('Заказы на ', 'target_date', 10, 10)).toEqual({ text: 'Заказы на {target_date}', cursor: 23 });
    expect(insertCaptionVariable('abcdef', 'weekday', 1, 3).text).toBe('a{weekday}def');
  });
});

describe('pending manual send storage', () => {
  it('keys by broadcast id and never leaks between broadcasts', () => {
    const storage = memoryStorage();
    expect(pendingManualSendKey(7)).toBe('broadcast.pending-manual-send.v1.7');
    persistPendingManualSend(7, { actorId: 'u1', payload: { settingsVersion: 2, idempotencyKey: UUID, confirmed: true }, ambiguous: true }, storage);
    expect(readPendingManualSend(8, 'u1', storage)).toBeNull();
    expect(readPendingManualSend(7, 'u2', storage)).toBeNull();
    expect(readPendingManualSend(7, 'u1', storage)).toMatchObject({ ambiguous: true, payload: { idempotencyKey: UUID } });
    clearPendingManualSend(7, storage);
    expect(readPendingManualSend(7, 'u1', storage)).toBeNull();
  });

  it('rejects corrupt entries', () => {
    const storage = memoryStorage();
    storage.setItem(pendingManualSendKey(1), '{bad');
    expect(readPendingManualSend(1, 'u1', storage)).toBeNull();
    storage.setItem(pendingManualSendKey(1), JSON.stringify({ actorId: 'u1', payload: { settingsVersion: 1, idempotencyKey: 'x', confirmed: true }, ambiguous: false }));
    expect(readPendingManualSend(1, 'u1', storage)).toBeNull();
  });
});

describe('errors', () => {
  it('maps backend codes to Russian text', () => {
    expect(broadcastErrorMessage(apiError('BROADCAST_TODAY_ALREADY_SENDING'), 'fb')).toContain('Сегодняшняя рассылка');
    expect(broadcastErrorMessage(apiError('BROADCAST_VERSION_CONFLICT'), 'fb')).toContain('изменена');
    expect(broadcastErrorMessage(apiError('BROADCASTS_PAUSED'), 'fb')).toContain('остановлены');
    expect(broadcastErrorMessage('boom', 'fb')).toBe('fb');
  });

  it('classifies definitely-not-queued errors', () => {
    expect(isKnownNotQueuedError(apiError('BROADCASTS_PAUSED'), false)).toBe(true);
    // An earlier attempt may still be in flight: a pause may be lifted before it runs, so the key stays.
    expect(isKnownNotQueuedError(apiError('BROADCASTS_PAUSED'), true)).toBe(false);
    expect(isKnownNotQueuedError(apiError('BROADCAST_RUNTIME_UNAVAILABLE', 503), true)).toBe(false);
    // Monotonic refusals are final either way.
    expect(isKnownNotQueuedError(apiError('BROADCAST_VERSION_CONFLICT'), true)).toBe(true);
    expect(isKnownNotQueuedError(apiError('BROADCAST_ARCHIVED'), true)).toBe(true);
    expect(isKnownNotQueuedError(apiError('BROADCAST_DESTINATION_REQUIRED'), true)).toBe(true);
    expect(isKnownNotQueuedError(apiError('VALIDATION_ERROR', 422), false)).toBe(true);
    expect(isKnownNotQueuedError(apiError('VALIDATION_ERROR', 422), true)).toBe(false);
    expect(isKnownNotQueuedError(new Error('network'), false)).toBe(false);
  });
});

describe('creation limit', () => {
  it('blocks when maxActive broadcasts are enabled', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, enabled: i < 2 })) as never[];
    expect(canCreateBroadcast(rows, 2)).toBe(false);
    expect(canCreateBroadcast(rows, 3)).toBe(true);
  });
});

describe('pending retry and replan', () => {
  const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const runId = '1f8fad5b-d9cb-469f-a165-70867728950e';

  it('keeps an unconfirmed retry for the same user and run until cleared (survives a remount)', () => {
    const storage = memoryStorage();
    persistPendingRetry({ actorId: '11', runId, payload: { mode: 'all', idempotencyKey: key, duplicateRiskConfirmed: true }, ambiguous: true }, storage);
    // A fresh component reads the same key back instead of generating a new one.
    expect(readPendingRetry(runId, '11', storage)).toEqual({ actorId: '11', runId, payload: { mode: 'all', idempotencyKey: key, duplicateRiskConfirmed: true }, ambiguous: true });
    expect(readPendingRetry(runId, '12', storage)).toBeNull();
    clearPendingRetry(runId, storage);
    expect(readPendingRetry(runId, '11', storage)).toBeNull();
  });

  it('keeps an unconfirmed replan with its original version', () => {
    const storage = memoryStorage();
    persistPendingReplan({ actorId: '11', broadcastId: 4, payload: { version: 7, idempotencyKey: key }, ambiguous: false }, storage);
    expect(readPendingReplan(4, '11', storage)?.payload).toEqual({ version: 7, idempotencyKey: key });
    expect(readPendingReplan(5, '11', storage)).toBeNull();
    clearPendingReplan(4, storage);
    expect(readPendingReplan(4, '11', storage)).toBeNull();
  });

  it('drops the key only on answers that prove the command had no effect', () => {
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_RETRY_ACTIVE', 409), false)).toBe(true);
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_TODAY_ALREADY_SENDING', 409), false)).toBe(true);
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_RUNTIME_UNAVAILABLE', 503), false)).toBe(true);
    // Transient refusals do not drop a key whose earlier attempt may still commit.
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_RETRY_ACTIVE', 409), true)).toBe(false);
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_TODAY_ALREADY_SENDING', 409), true)).toBe(false);
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_RUNTIME_UNAVAILABLE', 503), true)).toBe(false);
    // Monotonic ones do.
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_RUN_SUPERSEDED', 409), true)).toBe(true);
    expect(isKnownNotCreatedCommandError(apiError('BROADCAST_DEADLINE_PASSED', 410), true)).toBe(true);
    expect(isKnownNotCreatedCommandError(apiError('INTERNAL_ERROR', 500), false)).toBe(false);
    expect(isKnownNotCreatedCommandError(new Error('network'), false)).toBe(false);
    expect(isKnownNotCreatedCommandError(apiError('PERMISSION_DENIED', 403), true)).toBe(false);
  });
});

describe('retry availability', () => {
  const detail = (states: string[], runState = 'sent'): BroadcastRunDetail => ({
    run: { id: 'r', broadcastId: 1, businessDate: '2026-10-05', targetDate: '2026-10-05', kind: 'auto', parentRunId: null, state: runState as never,
      reason: null, orderCount: 1, totalArea: 1, destinationMasked: '…', createdAt: '', updatedAt: '', expiresAt: null, scheduledAt: null,
      superseded: false, messageCount: states.length, sentMessageCount: 0 },
    messages: states.map((state, index) => ({ deliverySeq: index + 1, kind: 'image' as const, orderIds: [1], state: state as never, attemptCount: 1,
      errorCode: null, sentAt: null, imageAvailable: true, expiresAt: '2999-01-01T00:00:00Z' })),
  });

  it('offers «Повторить всё» for a fully sent run and «оставшиеся» only when something is left', () => {
    expect(canRetryAll(detail(['sent', 'sent']))).toBe(true);
    expect(canRetryRemaining(detail(['sent', 'sent']))).toBe(false);
    expect(canRetryRemaining(detail(['sent', 'failed'], 'partial'))).toBe(true);
  });

  it('offers nothing while the run is still active', () => {
    expect(canRetryAll(detail(['pending'], 'queued'))).toBe(false);
    expect(canRetryRemaining(detail(['pending'], 'sending'))).toBe(false);
  });
});

describe('pending command protocol (retry / replan / manual send)', () => {
  const runId = '2f8fad5b-d9cb-469f-a165-70867728950e';
  const failingStorage = () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => undefined });

  const retryOnce = (storage: ReturnType<typeof memoryStorage> | ReturnType<typeof failingStorage>, send: (key: string) => Promise<unknown>,
    memory: Parameters<typeof persistPendingRetry>[0] | null = null) => runPendingCommand({
    stored: readPendingRetry(runId, '11', storage) ?? memory,
    fresh: () => ({ actorId: '11', runId, payload: { mode: 'remaining' as const, idempotencyKey: UUID, duplicateRiskConfirmed: true } }),
    persist: (request) => persistPendingRetry(request, storage),
    clear: () => clearPendingRetry(runId, storage),
    send: (request) => send(request.payload.idempotencyKey),
    isDefinite: isKnownNotCreatedCommandError,
  });

  it('stores the request as ambiguous before sending: page closed → restore → 403 keeps the key → rights back → replay of the same key', async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    // 1. Committed on the backend, but the page is closed before the answer arrives.
    void retryOnce(storage, (key) => { sent.push(key); return new Promise(() => undefined); });
    await Promise.resolve();
    expect(readPendingRetry(runId, '11', storage)?.ambiguous).toBe(true);
    // 2. Restored after reopening; the guard refuses (403) before the ledger is consulted.
    const denied = await retryOnce(storage, (key) => { sent.push(key); return Promise.reject(apiError('PERMISSION_DENIED', 403)); });
    expect(denied.status).toBe('uncertain');
    expect(readPendingRetry(runId, '11', storage)).not.toBeNull();
    // 3. Rights restored: the same key goes out again and the backend replays the first retry.
    const replayed = await retryOnce(storage, (key) => { sent.push(key); return Promise.resolve({ run: { id: 'child' } }); });
    expect(replayed).toMatchObject({ status: 'done', replayed: true });
    expect(new Set(sent)).toEqual(new Set([UUID]));
    expect(readPendingRetry(runId, '11', storage)).toBeNull();
  });

  it('drops a fresh key on a first-attempt 403 (nothing was ever sent before)', async () => {
    const storage = memoryStorage();
    const outcome = await retryOnce(storage, () => Promise.reject(apiError('PERMISSION_DENIED', 403)));
    expect(outcome.status).toBe('refused');
    expect(readPendingRetry(runId, '11', storage)).toBeNull();
  });

  it('does not send a new command when the key cannot be stored', async () => {
    const send = vi.fn();
    const outcome = await retryOnce(failingStorage(), send);
    expect(outcome.status).toBe('not-stored');
    expect(send).not.toHaveBeenCalled();
  });

  it('with a failing storage, «Проверить» resends the in-memory request instead of generating a new key', async () => {
    const storage = failingStorage();
    const memory = { actorId: '11', runId, payload: { mode: 'all' as const, idempotencyKey: UUID, duplicateRiskConfirmed: true }, ambiguous: true };
    const keys: string[] = [];
    const outcome = await retryOnce(storage, (key) => { keys.push(key); return Promise.resolve({}); }, memory);
    expect(outcome).toMatchObject({ status: 'done', replayed: true });
    expect(keys).toEqual([UUID]);
  });

  it('keeps the key on network errors and transient refusals, drops it on monotonic refusals', async () => {
    const storage = memoryStorage();
    expect((await retryOnce(storage, () => Promise.reject(new Error('network')))).status).toBe('uncertain');
    expect(readPendingRetry(runId, '11', storage)).not.toBeNull();
    expect((await retryOnce(storage, () => Promise.reject(apiError('BROADCAST_RETRY_ACTIVE', 409)))).status).toBe('uncertain');
    expect(readPendingRetry(runId, '11', storage)).not.toBeNull();
    expect((await retryOnce(storage, () => Promise.reject(apiError('BROADCAST_RUN_SUPERSEDED', 409)))).status).toBe('refused');
    expect(readPendingRetry(runId, '11', storage)).toBeNull();
  });
});
