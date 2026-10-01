import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import type { BroadcastRunDetail, CalendarSendSettings } from '../../../../api/broadcastsApiTypes';
import {
  buildCalendarSendUpdate,
  calendarSendDirty,
  calendarSendErrorToast,
  calendarSendStatusText,
  CALENDAR_SEND_UNCERTAIN_TEXT,
  formatDayShort,
  formatDayTitle,
  runCalendarSend,
  validateInterval,
} from './calendarSendModel';
import {
  isKnownCalendarSendNotQueuedError,
  readPendingCalendarSend,
  type PendingCalendarSend,
} from './broadcastModel';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const apiError = (status: number, code: string, details?: unknown) => new ApiError({ code, message: code, status, details });
const detail = (state: string) => ({ run: { state }, messages: [] }) as unknown as BroadcastRunDetail;
const KEY = 'broadcast.pending-calendar-send.v1.2026-10-02';

describe('calendar send formatting', () => {
  it('formats the day title and short form', () => {
    expect(formatDayTitle('2026-10-02')).toBe('Пт, 02.10.2026');
    expect(formatDayTitle('2026-10-01')).toBe('Чт, 01.10.2026');
    expect(formatDayShort('2026-10-01')).toBe('Чт, 01.10');
    expect(formatDayTitle('bad')).toBe('bad');
  });
});

describe('calendar send error toasts', () => {
  it('formats the cooldown with the Almaty time and interval', () => {
    const toast = calendarSendErrorToast(apiError(409, 'BROADCAST_CALENDAR_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z' }), 15);
    expect(toast).toEqual({ type: 'warning', text: 'Отправлять из календаря можно не чаще раза в 15 мин. Следующая отправка — не раньше 12:30' });
  });

  it('omits the interval when unknown', () => {
    const toast = calendarSendErrorToast(apiError(409, 'BROADCAST_CALENDAR_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z' }), null);
    expect(toast.text).toBe('Следующая отправка — не раньше 12:30');
  });

  it('maps the other known codes', () => {
    expect(calendarSendErrorToast(apiError(409, 'BROADCAST_CALENDAR_ACTIVE')).text).toBe('Предыдущая отправка из календаря ещё не завершена');
    expect(calendarSendErrorToast(apiError(409, 'BROADCAST_DESTINATION_REQUIRED')).text).toContain('Конфигурация → Рассылка сообщений → Отправка из календаря');
    expect(calendarSendErrorToast(apiError(409, 'BROADCASTS_PAUSED')).text).toBe('Все рассылки остановлены');
    expect(calendarSendErrorToast(apiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE')).text).toBe('WhatsApp сейчас недоступен');
  });

  it('treats network and plain 5xx as uncertain, other 4xx via the broadcast messages', () => {
    expect(calendarSendErrorToast(new TypeError('network')).text).toBe(CALENDAR_SEND_UNCERTAIN_TEXT);
    expect(calendarSendErrorToast(apiError(500, 'INTERNAL_ERROR')).text).toBe(CALENDAR_SEND_UNCERTAIN_TEXT);
    expect(calendarSendErrorToast(apiError(503, 'BROADCAST_RENDER_BUSY')).text).toContain('Картинки сейчас готовятся');
    expect(calendarSendErrorToast(apiError(422, 'VALIDATION_ERROR')).text).toBe('Проверьте заполнение полей.');
  });
});

describe('calendar send classifier', () => {
  it('first attempt: every 4xx is definite, 5xx and network are not', () => {
    expect(isKnownCalendarSendNotQueuedError(apiError(409, 'BROADCAST_CALENDAR_COOLDOWN'), false)).toBe(true);
    expect(isKnownCalendarSendNotQueuedError(apiError(403, 'PERMISSION_DENIED'), false)).toBe(true);
    expect(isKnownCalendarSendNotQueuedError(apiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE'), false)).toBe(false);
    expect(isKnownCalendarSendNotQueuedError(new TypeError('x'), false)).toBe(false);
  });

  it('after an ambiguous attempt only IDEMPOTENCY_KEY_REUSED is definite', () => {
    expect(isKnownCalendarSendNotQueuedError(apiError(409, 'IDEMPOTENCY_KEY_REUSED'), true)).toBe(true);
    expect(isKnownCalendarSendNotQueuedError(apiError(409, 'BROADCAST_CALENDAR_COOLDOWN'), true)).toBe(false);
    expect(isKnownCalendarSendNotQueuedError(apiError(409, 'BROADCASTS_PAUSED'), true)).toBe(false);
    expect(isKnownCalendarSendNotQueuedError(apiError(422, 'VALIDATION_ERROR'), true)).toBe(false);
  });
});

describe('runCalendarSend', () => {
  it('queues a day, stores the key before sending and drops it after the answer', async () => {
    const storage = memoryStorage();
    const send = vi.fn(async (body: { date: string; idempotencyKey: string }) => {
      expect(JSON.parse(storage.data.get(KEY) as string)).toMatchObject({ date: '2026-10-02', ambiguous: true, payload: body });
      return detail('queued');
    });
    const toast = await runCalendarSend({ date: '2026-10-02', actorId: '7', send, storage });
    expect(toast).toEqual({ type: 'success', text: 'Отправка за Пт, 02.10 поставлена в очередь' });
    expect(send.mock.calls[0][0].date).toBe('2026-10-02');
    expect(send.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('reports an empty day', async () => {
    const toast = await runCalendarSend({ date: '2026-10-02', actorId: '7', send: async () => detail('empty'), storage: memoryStorage() });
    expect(toast).toEqual({ type: 'info', text: 'На 02.10 заказов нет — ничего не отправлено' });
  });

  it('drops the key on a first-attempt 4xx', async () => {
    const storage = memoryStorage();
    const toast = await runCalendarSend({ date: '2026-10-02', actorId: '7', storage, minIntervalMinutes: 15,
      send: async () => { throw apiError(409, 'BROADCAST_CALENDAR_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z' }); } });
    expect(toast?.type).toBe('warning');
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('keeps the key after a network failure and replays the same key next time', async () => {
    const storage = memoryStorage();
    const bodies: Array<{ idempotencyKey: string }> = [];
    const toast = await runCalendarSend({ date: '2026-10-02', actorId: '7', storage, send: async (body) => { bodies.push(body); throw new TypeError('network'); } });
    expect(toast?.text).toBe(CALENDAR_SEND_UNCERTAIN_TEXT);
    const stored = readPendingCalendarSend('2026-10-02', '7', storage) as PendingCalendarSend;
    expect(stored.ambiguous).toBe(true);
    // A cooldown refusal after the ambiguous attempt is not definite: the key stays.
    await runCalendarSend({ date: '2026-10-02', actorId: '7', storage, send: async (body) => { bodies.push(body); throw apiError(409, 'BROADCAST_CALENDAR_COOLDOWN'); } });
    expect(readPendingCalendarSend('2026-10-02', '7', storage)).not.toBeNull();
    await runCalendarSend({ date: '2026-10-02', actorId: '7', storage, send: async (body) => { bodies.push(body); return detail('queued'); } });
    expect(new Set(bodies.map((b) => b.idempotencyKey)).size).toBe(1);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('does not send when the key cannot be stored', async () => {
    const send = vi.fn();
    const storage = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    const toast = await runCalendarSend({ date: '2026-10-02', actorId: '7', send, storage });
    expect(send).not.toHaveBeenCalled();
    expect(toast?.type).toBe('error');
  });

  it('ignores a second click for the same date while one is in flight', async () => {
    let release: (value: BroadcastRunDetail) => void = () => undefined;
    const send = vi.fn(() => new Promise<BroadcastRunDetail>((resolve) => { release = resolve; }));
    const storage = memoryStorage();
    const first = runCalendarSend({ date: '2026-10-02', actorId: '7', send, storage });
    expect(await runCalendarSend({ date: '2026-10-02', actorId: '7', send, storage })).toBeNull();
    release(detail('queued'));
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('calendar send settings model', () => {
  const settings: CalendarSendSettings = {
    broadcastId: 9, version: 4, groupChatId: '123456789@g.us', cardsPerMessage: 2, captionTemplate: 'x',
    minIntervalMinutes: 15, updatedAt: '2026-10-01T00:00:00Z', updatedBy: null,
  };

  it('validates the interval', () => {
    expect(validateInterval(1)).toBeNull();
    expect(validateInterval(1440)).toBeNull();
    for (const bad of [0, 1441, 1.5, null, undefined]) expect(validateInterval(bad)).not.toBeNull();
  });

  it('builds the CAS body and refuses an invalid interval', () => {
    const values = { groupChatId: ' 123456789@g.us ', cardsPerMessage: 1 as const, captionTemplate: 'c', minIntervalMinutes: 30 };
    expect(buildCalendarSendUpdate(4, values)).toEqual({ version: 4, groupChatId: '123456789@g.us', cardsPerMessage: 1, captionTemplate: 'c', minIntervalMinutes: 30 });
    expect(buildCalendarSendUpdate(4, { ...values, groupChatId: '' })?.groupChatId).toBeNull();
    expect(buildCalendarSendUpdate(4, { ...values, minIntervalMinutes: null })).toBeNull();
  });

  it('detects dirtiness', () => {
    expect(calendarSendDirty({}, settings)).toBe(false);
    expect(calendarSendDirty({ minIntervalMinutes: 15, cardsPerMessage: 2 }, settings)).toBe(false);
    expect(calendarSendDirty({ minIntervalMinutes: 30 }, settings)).toBe(true);
    expect(calendarSendDirty({ groupChatId: null }, settings)).toBe(true);
  });

  it('builds the status line', () => {
    const now = Date.parse('2026-10-01T07:00:00Z');
    expect(calendarSendStatusText('2026-10-01T07:30:00Z', false, now)).toBe('Следующая отправка из календаря возможна с 12:30.');
    expect(calendarSendStatusText('2026-10-01T06:30:00Z', false, now)).toBeNull();
    expect(calendarSendStatusText(null, true, now)).toContain('ещё выполняется');
  });
});
