import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import { parkedNumber, planPhoneSet, samePhoneSet } from '../client-phones/adapters/pg-client-phone-repository';
import type { ClientPhoneDto } from '../client-phones/dto/client-phone.dto';
import { likePattern, searchDigitVariants, searchDigits } from './client-contacts-list.repository';
import { parseListQuery } from './client-contacts.controller';

const codeOf = (call: () => unknown) => {
  try { call(); return 'ok'; } catch (error) { return error instanceof ApiError ? error.code : String(error); }
};
const phone = (phoneId: number, phoneNumber: string, isPrimary = false, phoneType: ClientPhoneDto['phoneType'] = 'mobile'): ClientPhoneDto => ({
  phoneId, clientId: 1, phoneNumber, phoneType, isPrimary, refKey1c: null, createdBy: null, editedBy: null, createdAt: '', updatedAt: null,
});
const seen = (phones: ClientPhoneDto[]) => phones.map(({ phoneId, phoneNumber, phoneType, isPrimary }) => ({ phoneId, phoneNumber, phoneType, isPrimary }));

describe('«Контакты клиентов» list query', () => {
  it('reads defaults, column filters and limits', () => {
    expect(parseListQuery({})).toEqual({ q: null, filters: {}, active: 'active', sort: 'client', order: 'asc', page: 1, pageSize: 50 });
    expect(parseListQuery({ q: '  701 ', 'f.whatsapp': 'has', 'f.email': 'none', 'f.other': '~vk', sort: 'viber', order: 'desc', active: 'all', page: '2', pageSize: '100' }))
      .toEqual({ q: '701', filters: { whatsapp: { mode: 'has' }, email: { mode: 'none' }, other: { mode: 'contains', text: 'vk' } },
        active: 'all', sort: 'viber', order: 'desc', page: 2, pageSize: 100 });
    for (const bad of [{ pageSize: '101' }, { page: '0' }, { sort: 'name' }, { order: 'up' }, { active: 'yes' }, { 'f.phone': 'maybe' }]) {
      expect(codeOf(() => parseListQuery(bad))).toBe('VALIDATION_ERROR');
    }
  });

  it('searches phones by a fragment; only a full number with a leading 8 becomes 7…', () => {
    expect(searchDigits('812')).toBe('812');
    expect(searchDigits('8 701 555 01 01')).toBe('77015550101');
    expect(searchDigits('+7 (701) 555')).toBe('7701555');
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
    // a start of a number typed with 8 also finds the numbers written +7 …; a short fragment stays itself
    expect(searchDigitVariants('8701')).toEqual(['8701', '7701']);
    expect(searchDigitVariants('8 701 555')).toEqual(['8701555', '7701555']);
    expect(searchDigitVariants('812')).toEqual(['812']);
    expect(searchDigitVariants('87015550101')).toEqual(['77015550101']);
  });
});

describe('phone set of the contacts screen', () => {
  const stored = [phone(1, '+7 701 555 01 01', true), phone(2, '8 727 222 33 44', false, 'work')];

  it('equals only the very set the screen saw (id, number, type, primary)', () => {
    expect(samePhoneSet(stored, seen(stored))).toBe(true);
    expect(samePhoneSet(stored, seen([stored[0]]))).toBe(false);
    expect(samePhoneSet(stored, seen([stored[0], phone(2, '8 727 222 33 44', false, 'home')]))).toBe(false);
    expect(samePhoneSet(stored, seen([phone(1, '+7 701 555 01 01', false), phone(2, '8 727 222 33 44', true, 'work')]))).toBe(false);
    // the Bitrix24 sync replaced the rows: same numbers, new ids
    expect(samePhoneSet([phone(7, '+7 701 555 01 01', true), phone(8, '8 727 222 33 44', false, 'work')], seen(stored))).toBe(false);
    expect(samePhoneSet(stored, [...seen(stored), ...seen([stored[0]])])).toBe(false);
  });

  it('compares an old phone with no type / no primary mark as stored (NULL equals NULL only)', () => {
    const old = { ...phone(3, '8 727 000 00 01'), phoneType: null, isPrimary: null } as unknown as ClientPhoneDto;
    const nulls = { phoneId: 3, phoneNumber: '8 727 000 00 01', phoneType: null, isPrimary: null };
    expect(samePhoneSet([old], [nulls])).toBe(true);
    expect(samePhoneSet([old], [{ ...nulls, phoneType: 'mobile', isPrimary: false }])).toBe(false);
  });

  it('plans removals, changes and new phones; moves the primary', () => {
    const plan = planPhoneSet(stored, [
      { phoneId: 2, phoneNumber: '8 727 222 33 44', phoneType: 'work', isPrimary: true },
      { phoneId: null, phoneNumber: '+7 705 000 11 22', phoneType: 'mobile', isPrimary: false },
    ]);
    expect(plan.deleted.map((row) => row.phoneId)).toEqual([1]);
    expect(plan.updated).toEqual([{ before: stored[1], after: { phoneNumber: '8 727 222 33 44', phoneType: 'work', isPrimary: true } }]);
    expect(plan.created).toEqual([{ phoneNumber: '+7 705 000 11 22', phoneType: 'mobile', isPrimary: false }]);
    expect(planPhoneSet(stored, seen(stored))).toEqual({ deleted: [], updated: [], created: [] });
  });

  it('parks a phone on a placeholder no number of the client has, now or after the command', () => {
    expect(parkedNumber(101, new Set())).toBe('+0000000000000000101');
    expect(parkedNumber(101, new Set(['+0000000000000000101']))).toBe('+1000000000000000101');
    expect(/^\+?[0-9\s\-()]{7,20}$/.test(parkedNumber(9_007_199, new Set()))).toBe(true);
    const all = new Set(Array.from({ length: 10 }, (_, lead) => `+${lead}${'101'.padStart(18, '0')}`));
    expect(codeOf(() => parkedNumber(101, all))).toBe('CLIENT_PHONE_SET_INVALID');
  });

  it('names the line, never the number, in its errors', () => {
    for (const lines of [[{ phoneId: null, phoneNumber: 'нет 5550101', phoneType: 'mobile' as const, isPrimary: false }],
      [{ phoneId: 1, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile' as const, isPrimary: true }, { phoneId: null, phoneNumber: '+77015550101', phoneType: 'mobile' as const, isPrimary: false }]]) {
      try { planPhoneSet(stored, lines); } catch (error) { expect(JSON.stringify({ m: (error as ApiError).message, d: (error as ApiError).details })).not.toMatch(/555/); }
    }
  });

  it('refuses bad numbers, foreign or repeated ids, repeated numbers, two primaries, too many phones', () => {
    const line = (phoneId: number | null, phoneNumber: string, isPrimary = false) => ({ phoneId, phoneNumber, phoneType: 'mobile' as const, isPrimary });
    for (const lines of [
      [line(null, 'нет номера')],
      [line(9, '+7 701 000 00 00')],
      [line(1, '+7 701 555 01 01'), line(1, '+7 701 555 01 02')],
      [line(1, '+7 701 555 01 01'), line(null, '+7(701)555-01-01')],
      [line(1, '+7 701 555 01 01', true), line(null, '+7 705 000 11 22', true)],
      Array.from({ length: 21 }, (_, index) => line(null, `+7 701 000 00 ${String(index).padStart(2, '0')}`)),
    ]) {
      expect(codeOf(() => planPhoneSet(stored, lines))).toBe('CLIENT_PHONE_SET_INVALID');
    }
  });
});
