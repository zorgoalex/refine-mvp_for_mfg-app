import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { renderCaption, validateCaptionTemplate } from './broadcast-caption';
import { parseBroadcastCreate, parseBroadcastId, parseBroadcastUpdate, parseDeliverySeq, parseRunId } from './broadcast.dto';
import { addDays, automaticDeliveryDeadline, businessDate, fixationWindowState, isoWeekday, zonedMinute } from './broadcast-time';

const base = {
  name: '  Цех  ', enabled: true, groupChatId: '120363338054016575@g.us', weekdays: [5, 1, 1, 3], sendTime: '08:45', sendWindowMinutes: 30,
  catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00', partialPolicy: 'remaining', orderDateOffsetDays: 1, cardsPerMessage: 2,
  captionTemplate: ' Заказы на {target_date} ',
};

describe('broadcast time', () => {
  it('computes Almaty business dates, ISO weekdays and day offsets', () => {
    expect(businessDate(new Date('2026-09-29T19:30:00Z'))).toBe('2026-09-30');
    expect(isoWeekday('2026-09-28')).toBe(1);
    expect(isoWeekday('2026-10-04')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(zonedMinute('2026-09-30', 8 * 60 + 45)).toBe('2026-09-30T08:45:00.000+05:00');
  });

  it('decides the window once at fixation for every catch-up policy', () => {
    const scheduledAt = new Date('2026-09-30T08:52:00.000+05:00');
    const at = (clock: string) => new Date(`2026-09-30T${clock}+05:00`);
    const skip = { scheduledAt, catchUpPolicy: 'skip' as const, catchUpDeadline: '10:00' };
    expect(fixationWindowState(skip, at('08:51:59'))).toBe('before');
    expect(fixationWindowState(skip, at('08:52:40'))).toBe('open');
    expect(fixationWindowState(skip, at('08:53:00'))).toBe('missed');
    const deadline = { ...skip, catchUpPolicy: 'until_deadline' as const };
    expect(fixationWindowState(deadline, at('10:00:59'))).toBe('open');
    expect(fixationWindowState(deadline, at('10:01:00'))).toBe('missed');
    const endOfDay = { ...skip, catchUpPolicy: 'end_of_day' as const };
    expect(fixationWindowState(endOfDay, at('23:59:30'))).toBe('open');
    expect(fixationWindowState(endOfDay, new Date('2026-10-01T00:00:10+05:00'))).toBe('missed');
  });

  it('gives skip runs a 30-minute delivery grace and others their catch-up limit', () => {
    const scheduledAt = new Date('2026-09-30T08:52:00.000+05:00');
    expect(automaticDeliveryDeadline({ scheduledAt, catchUpPolicy: 'skip', catchUpDeadline: '10:00' }, '2026-09-30').toISOString())
      .toBe('2026-09-30T04:22:00.000Z');
    expect(automaticDeliveryDeadline({ scheduledAt, catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00' }, '2026-09-30').toISOString())
      .toBe('2026-09-30T05:00:59.999Z');
    expect(automaticDeliveryDeadline({ scheduledAt, catchUpPolicy: 'end_of_day', catchUpDeadline: '10:00' }, '2026-09-30').toISOString())
      .toBe('2026-09-30T18:59:59.999Z');
  });
});

describe('broadcast caption', () => {
  it('renders date variables in Almaty and keeps escaped braces', () => {
    const caption = renderCaption('Заказы на {target_date} ({target_weekday}) {{сводка}}, отправлено {current_date} {current_time}, {weekday}',
      { now: new Date('2026-09-30T03:45:00Z'), targetDate: '2026-10-01' });
    expect(caption).toBe('Заказы на 01.10.2026 (четверг) {сводка}, отправлено 30.09.2026 08:45, среда');
  });

  it('rejects unknown variables and unbalanced braces with 422', () => {
    for (const template of ['{orders_count}', 'Заказы {target_date', 'лишняя }']) {
      expect(() => validateCaptionTemplate(template), template).toThrow(expect.objectContaining({ statusCode: 422 }));
    }
    expect(validateCaptionTemplate('')).toBe('');
  });
});

describe('calendar send DTO', () => {
  it('accepts a real day within a year and a 1–1440 minute threshold', async () => {
    const { parseCalendarSendRun, parseCalendarSendUpdate } = await import('./broadcast.dto');
    const now = new Date('2026-10-01T06:00:00Z');
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseCalendarSendRun({ date: '2026-09-01', idempotencyKey: key }, now).date).toBe('2026-09-01');
    expect(parseCalendarSendRun({ date: '2027-10-02', idempotencyKey: key }, now).date).toBe('2027-10-02');
    for (const date of ['2025-09-29', '2027-10-03', '2026-02-30', '2026-9-1']) {
      expect(() => parseCalendarSendRun({ date, idempotencyKey: key }, now)).toThrow();
    }
    expect(() => parseCalendarSendRun({ date: '2026-10-01', idempotencyKey: key, extra: 1 }, now)).toThrow();
    const base = { version: 1, groupChatId: ' 120363338054016575@g.us ', cardsPerMessage: 2, captionTemplate: 'Заказы на {target_date}', minIntervalMinutes: 15 };
    expect(parseCalendarSendUpdate(base)).toMatchObject({ groupChatId: '120363338054016575@g.us', minIntervalMinutes: 15 });
    for (const minIntervalMinutes of [0, 1441, 1.5]) expect(() => parseCalendarSendUpdate({ ...base, minIntervalMinutes })).toThrow();
    expect(() => parseCalendarSendUpdate({ ...base, captionTemplate: '{nope}' })).toThrow();
    expect(() => parseCalendarSendUpdate({ ...base, groupChatId: 'bad' })).toThrow();
  });
});

describe('broadcast DTO', () => {
  it('normalizes name, weekdays and caption', () => {
    const input = parseBroadcastCreate(base);
    expect(input).toMatchObject({ name: 'Цех', weekdays: [1, 3, 5], captionTemplate: 'Заказы на {target_date}', duplicateRiskConfirmed: false });
    expect(parseBroadcastUpdate({ ...base, version: 3 }).version).toBe(3);
  });

  it('rejects incoherent settings', () => {
    const cases: Array<Record<string, unknown>> = [
      { ...base, groupChatId: null },
      { ...base, weekdays: [] },
      { ...base, weekdays: [8] },
      { ...base, groupChatId: '77010000001@s.whatsapp.net' },
      { ...base, sendTime: '23:50', sendWindowMinutes: 10 },
      { ...base, catchUpDeadline: '09:00' },
      { ...base, orderDateOffsetDays: 15 },
      { ...base, captionTemplate: '{unknown}' },
      { ...base, extra: true },
    ];
    for (const value of cases) expect(() => parseBroadcastCreate(value), JSON.stringify(value)).toThrow(ApiError);
    expect(() => parseBroadcastCreate({ ...base, partialPolicy: 'repeat_all' })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(parseBroadcastCreate({ ...base, enabled: false, groupChatId: null, weekdays: [] })).toMatchObject({ enabled: false, groupChatId: null });
  });

  it('validates path parameters', () => {
    expect(parseBroadcastId('12')).toBe(12);
    for (const bad of ['0', '-1', '1.5', 'control', '99999999999999999']) expect(() => parseBroadcastId(bad), bad).toThrow(ApiError);
    expect(parseRunId('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(() => parseRunId('not-a-uuid')).toThrow(ApiError);
    expect(parseDeliverySeq('560')).toBe(560);
    expect(() => parseDeliverySeq('561')).toThrow(ApiError);
  });
});
