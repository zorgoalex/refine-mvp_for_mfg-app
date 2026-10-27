import { describe, expect, it } from 'vitest';
import { clientContactsSearch, type ClientContactsRow } from '../../api/clientContactsApi';
import { draftToInput } from '../../components/contacts/contactsModel';
import {
  DEFAULT_QUERY, addPhoneDraft, phoneLines, columnValues, hasFilters, keyFor, kindDraftToSet, kindToDraft, phoneDraftToLines, phonesToDraft, readQuery,
  listError, rebaseKindDraft, rebasePhoneDraft, removePhoneDraft, requestGate, setPhonePrimary, writeQuery,
} from './clientContactsModel';
import { ApiError } from '../../api/apiError';

const row: ClientContactsRow = {
  client: { id: 7, name: 'Тест Клиент', isActive: true, personType: null },
  phones: [{ phoneId: 1, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile', isPrimary: true }, { phoneId: 2, phoneNumber: '8 727 222 33 44', phoneType: 'work', isPrimary: false }],
  contacts: [
    { contactId: 10, kind: 'email', value: 'a@b.kz', valueNormalized: 'a@b.kz', isPrimary: true, note: null },
    { contactId: 11, kind: 'whatsapp', value: '+7 701 555 01 01', valueNormalized: '77015550101', isPrimary: true, note: 'личный' },
    { contactId: 12, kind: 'other', value: 'vk.com/test', valueNormalized: 'vk.com/test', isPrimary: true, note: 'VK' },
  ],
  contactsVersion: 3,
  updatedAt: null,
};

describe('«Контакты клиентов» query in the URL', () => {
  it('round-trips a query and keeps only what differs from the default', () => {
    const query = { ...DEFAULT_QUERY, q: '701', page: 3, sort: 'whatsapp' as const, order: 'desc' as const, active: 'all' as const,
      filters: { email: 'none' as const, other: '~vk' as const } };
    expect(readQuery(writeQuery(query))).toEqual(query);
    expect(writeQuery(DEFAULT_QUERY).toString()).toBe('');
    expect(hasFilters(DEFAULT_QUERY)).toBe(false);
    expect(hasFilters(query)).toBe(true);
  });

  it('ignores unknown values', () => {
    expect(readQuery(new URLSearchParams('sort=name&order=up&pageSize=13&page=-1&active=x&f.phone=maybe&f.email=~'))).toEqual(DEFAULT_QUERY);
  });

  it('sends the column filters as f.<column>', () => {
    expect(clientContactsSearch({ ...DEFAULT_QUERY, filters: { whatsapp: 'has', phone: '~812' } }))
      .toBe('page=1&pageSize=50&sort=client&order=asc&active=active&f.phone=%7E812&f.whatsapp=has');
  });
});

describe('list requests', () => {
  it('lets only the latest request apply its answer (an earlier search answering late is dropped)', () => {
    const gate = requestGate();
    const first = gate.start();
    const second = gate.start();
    expect(gate.isLatest(second)).toBe(true);
    expect(gate.isLatest(first)).toBe(false);
  });

  it('tells an older backend (404) from other errors', () => {
    expect(listError(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' }))).toBe('Экран ещё недоступен: backend не обновлён');
    expect(listError(new Error('сеть'))).toBe('сеть');
  });
});

describe('phones editor', () => {
  it('moves the primary, hands it over on removal, checks numbers locally', () => {
    let rows = phonesToDraft(row.phones);
    rows = setPhonePrimary(rows, rows[1].rowKey);
    expect(rows.map((item) => item.isPrimary)).toEqual([false, true]);
    rows = removePhoneDraft(rows, rows[1].rowKey);
    expect(rows.map((item) => item.isPrimary)).toEqual([true]);
    expect(phoneDraftToLines(addPhoneDraft(rows))).toEqual({ error: 'Заполните номер или удалите пустую строку' });
    const twice = [...rows, { ...rows[0], rowKey: 'x', phoneId: null, phoneNumber: '+7(701)555-01-01', isPrimary: false }];
    expect(phoneDraftToLines(twice)).toEqual({ error: 'Телефон «+7(701)555-01-01» указан дважды' });
    expect(phoneDraftToLines(rows)).toEqual({ phones: [{ phoneId: 1, phoneNumber: '+7 701 555 01 01', phoneType: 'mobile', isPrimary: true }] });
  });

  it('an old phone with no type / no primary mark: sent back as seen, drafted as «mobile» / not primary', () => {
    const old = { phoneId: 9, phoneNumber: '8 727 000 00 01', phoneType: null, isPrimary: null };
    expect(phoneLines([old])).toEqual([old]);
    expect(phonesToDraft([old])[0]).toMatchObject({ phoneType: 'mobile', isPrimary: false });
  });

  it('after a conflict keeps the draft; a phone that is gone becomes new', () => {
    const rows = phonesToDraft(row.phones);
    expect(rebasePhoneDraft(rows, [row.phones[1]]).map((item) => item.phoneId)).toEqual([null, 2]);
  });

  it('keeps the key for the same body, takes a new one for another', () => {
    let counter = 0;
    const fresh = () => `k${++counter}`;
    const first = keyFor(null, 'a', fresh);
    expect(keyFor(first, 'a', fresh)).toBe(first);
    expect(keyFor(first, 'b', fresh).key).toBe('k2');
  });
});

describe('one kind of contacts', () => {
  it('sends the whole set: other kinds as they are, the edited kind from the draft', () => {
    const drafts = kindToDraft(row, 'whatsapp');
    expect(columnValues(row, 'whatsapp')).toHaveLength(1);
    const body = kindDraftToSet(row, 'whatsapp', [...drafts, { rowKey: 'n', contactId: null, value: ' 87010000000 ', note: '', isPrimary: false }]);
    expect(body).toEqual({ contacts: [
      { contactId: 10, kind: 'email', value: 'a@b.kz', isPrimary: true, note: null },
      { contactId: 12, kind: 'other', value: 'vk.com/test', isPrimary: true, note: 'VK' },
      { contactId: 11, kind: 'whatsapp', value: '+7 701 555 01 01', isPrimary: true, note: 'личный' },
      { contactId: null, kind: 'whatsapp', value: '87010000000', isPrimary: false, note: null },
    ] });
  });

  it('needs a label for «Другое» and a value everywhere; a removed contact becomes new after a conflict', () => {
    expect(kindDraftToSet(row, 'other', [{ rowKey: 'n', contactId: null, value: 'x', note: ' ', isPrimary: true }]))
      .toEqual({ error: 'У контакта «Другое» укажите подпись (например, VK)' });
    expect(kindDraftToSet(row, 'email', [{ rowKey: 'n', contactId: null, value: ' ', note: '', isPrimary: true }])).toHaveProperty('error');
    expect(rebaseKindDraft(kindToDraft(row, 'email'), { ...row, contacts: [] }, 'email')[0].contactId).toBeNull();
    expect(draftToInput([{ rowKey: 'r', contactId: null, kind: 'other', value: 'vk', isPrimary: true, note: '', fromOnec: false }]))
      .toEqual({ error: 'У контакта «Другое» укажите подпись (например, VK)' });
  });
});
