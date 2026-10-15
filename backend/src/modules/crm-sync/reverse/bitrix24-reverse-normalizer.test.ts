import { describe, expect, it } from 'vitest';
import {
  bitrixCounterparty,
  normalizeBitrixClient,
  normalizeBitrixDeal,
  normalizeBitrixPayment,
  paymentIsErpOrigin,
} from './bitrix24-reverse-normalizer';
import { hash, mapClient } from '../application/bitrix24-sync-mapper';

describe('Bitrix24 reverse normalizer', () => {
  it('keeps creator separate from assignment without changing business hash', () => {
    const options = { clientId: null, portalDomain: 'mebelkz.bitrix24.kz', portalTimezone: 'Asia/Almaty', counterparty: null };
    const base = normalizeBitrixDeal('20', { title: 'Test', assignedById: 9 }, options);
    const authored = normalizeBitrixDeal('20', { title: 'Test', assignedById: 9, createdBy: 2, updatedBy: 3 }, options);
    expect(authored.rawSnapshot).toMatchObject({ createdBy: '2', updatedBy: '3', assignedById: '9' });
    expect(authored.normalizedHash).toBe(base.normalizedHash);
  });

  it('records paid-state actor, never infers creator from responsible user', () => {
    const base = normalizeBitrixPayment('44', { sum: 100, paid: 'Y' });
    const authored = normalizeBitrixPayment('44', { sum: 100, paid: 'Y', empPaidId: 4, responsibleId: 5 });
    expect(authored).toMatchObject({ paidById: '4' });
    expect(authored.normalizedHash).toBe(base.normalizedHash);
    expect(normalizeBitrixPayment('44', { empPaidId: 0, responsibleId: 5 }).paidById).toBeNull();
  });
  it('normalizes Contact names, phones and ERP origin', () => {
    const result = normalizeBitrixClient('contact', '77', {
      name: 'Иван',
      lastName: 'Иванов',
      originatorId: 'MEBELKZ_ERP',
      originId: 'CLIENT_10',
      fm: {
        1: { typeId: 'PHONE', valueType: 'MOBILE', value: '+77001234567' },
      },
      updatedTime: '2026-07-30T10:00:00+05:00',
    });
    expect(result).toMatchObject({
      name: 'Иван Иванов',
      originErpId: '10',
      phones: [{
        phoneNumber: '+77001234567',
        phoneType: 'mobile',
        isPrimary: true,
      }],
    });
  });

  it('does not bring ERP service lines or BB-code back into client notes', () => {
    expect(normalizeBitrixClient('contact', '77', {
      name: 'Иван',
      comments: '[p]\nERP ID клиента - 2550\n[/p]\nERP ID клиента: 2550',
    }).notes).toBeNull();
    expect(normalizeBitrixClient('company', '78', {
      title: 'ТОО Тест',
      comments: 'ТОО "Тест"\nвторая строка\nERP ID клиента: 10',
    }).notes).toBe('ТОО "Тест"\nвторая строка');
  });

  it('marks ERP\'s own inactive projection so the echo does not reactivate the client', () => {
    expect(normalizeBitrixClient('contact', '79', {
      name: 'Иван',
      comments: 'Заметка\nСтатус ERP: неактивен\nERP ID клиента: 10',
    })).toMatchObject({ notes: 'Заметка', erpMarkedInactive: true });
    expect(normalizeBitrixClient('contact', '79', { name: 'Иван', comments: 'Заметка' }).erpMarkedInactive).toBe(false);
  });

  it('round-trips long ERP notes through Bitrix24 unchanged (ERP → comment → echo → notes)', () => {
    const notes = 'а'.repeat(9999) + '😀' + 'б'.repeat(25) + '\n\nвторой абзац "в кавычках"';
    for (const isActive of [true, false]) {
      const sent = mapClient({
        clientId: '10', clientName: 'Иван', personType: 'individual', notes, isActive, phones: [],
      }, null);
      const echo = normalizeBitrixClient('contact', '80', { name: 'Иван', comments: sent.fields.comments });
      expect(echo.notes).toBe(notes);
      expect(echo.erpMarkedInactive).toBe(!isActive);
      // The snapshot is stored as jsonb: no lone surrogate may reach it.
      expect(JSON.stringify(echo.rawSnapshot)).not.toMatch(/\\ud83d(?!\\ude00)/i);
      expect(String(echo.rawSnapshot.comments)).toBe(String(sent.fields.comments).trim().slice(0, 9999));
      expect(echo.rawSnapshot.commentsHash).toBe(hash({ comments: String(sent.fields.comments).trim() }));
    }
  });

  it('keeps the client snapshot within the 256 KiB row limit for any comment size', () => {
    const comments = 'я'.repeat(140000);
    const result = normalizeBitrixClient('contact', '81', { name: 'Иван', comments });
    expect(result.notes).toBe(comments);
    expect(Buffer.byteLength(JSON.stringify(result.rawSnapshot), 'utf8')).toBeLessThan(64 * 1024);
    const changed = normalizeBitrixClient('contact', '81', { name: 'Иван', comments: comments + 'ю' });
    expect(changed.normalizedHash).not.toBe(result.normalizedHash);
  });

  it('cuts long deal text before, not inside, a surrogate pair', () => {
    const title = 'т'.repeat(9999) + '😀' + 'хвост';
    const deal = normalizeBitrixDeal('21', { title }, {
      clientId: null, portalDomain: 'mebelkz.bitrix24.kz', portalTimezone: 'Asia/Almaty', counterparty: null,
    });
    expect(deal.rawSnapshot.title).toBe('т'.repeat(9999));
    expect(JSON.stringify(deal.rawSnapshot)).not.toMatch(/\\ud83d/i);
  });

  it('keeps Deal opportunity separate and chooses Company before Contact', () => {
    const item = {
      title: 'Новая кухня',
      opportunity: '125000',
      currencyId: 'KZT',
      companyId: 9,
      contactId: 8,
    };
    expect(bitrixCounterparty(item)).toEqual({ objectType: 'company', bitrixId: '9' });
    expect(normalizeBitrixDeal('20', item, {
      clientId: 5,
      portalDomain: 'mebelkz.bitrix24.kz',
      portalTimezone: 'Asia/Almaty',
      counterparty: { objectType: 'company', bitrixId: '9' },
    })).toMatchObject({
      crmAmount: 125000,
      clientId: 5,
      counterpartyObjectType: 'company',
      counterpartyBitrixId: '9',
      bitrixUrl: 'https://mebelkz.bitrix24.kz/crm/deal/details/20/',
    });
  });

  it('uses portal timezone for missing begin date and bounds the ERP title', () => {
    const result = normalizeBitrixDeal('21', {
      title: `  ${'A'.repeat(220)}  `,
      createdTime: '2026-07-30T20:30:00Z',
    }, {
      clientId: null,
      portalDomain: 'mebelkz.bitrix24.kz',
      portalTimezone: 'Asia/Almaty',
      counterparty: null,
    });

    expect(result.beginDate).toBe('2026-07-31');
    expect(result.title).toHaveLength(200);
    expect(result.fullTitle).toHaveLength(220);
  });

  it('recognizes ERP payments and normalizes manual payment date', () => {
    expect(paymentIsErpOrigin({ xmlId: 'MEBELKZ_ERP_PAYMENT_30' })).toBe(true);
    expect(paymentIsErpOrigin({ xmlId: 'manual' })).toBe(false);
    expect(normalizeBitrixPayment('44', {
      paySystemId: 12,
      sum: '5000',
      currency: 'KZT',
      paid: 'Y',
      datePaid: '2026-07-20T12:00:00+05:00',
    })).toMatchObject({
      paySystemId: 12,
      amount: 5000,
      paid: true,
    });
  });
});
