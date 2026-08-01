import { describe, expect, it } from 'vitest';
import {
  bitrixCounterparty,
  normalizeBitrixClient,
  normalizeBitrixDeal,
  normalizeBitrixPayment,
  paymentIsErpOrigin,
} from './bitrix24-reverse-normalizer';

describe('Bitrix24 reverse normalizer', () => {
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
