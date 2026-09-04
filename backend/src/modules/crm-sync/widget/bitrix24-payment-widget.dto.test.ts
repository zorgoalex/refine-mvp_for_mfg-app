import { describe, expect, it } from 'vitest';
import {
  parseCreateWidgetPaymentInput,
  parseResolvePaymentAmbiguityInput,
  parseRuntimeAuth,
  parseWidgetCallback,
  parseWidgetAuthorization,
  requestHash,
} from './bitrix24-payment-widget.dto';

const callback = {
  AUTH_ID: 'access-token-value',
  AUTH_EXPIRES: '3600',
  REFRESH_ID: 'refresh-token-value',
  member_id: 'member-12345678',
  status: 'L',
  APPLICATION_TOKEN: 'application-token-value',
  APPLICATION_SCOPE: 'crm,sale,pay_system,placement,user_basic',
};

describe('Bitrix24 payment widget DTO', () => {
  it('merges the real placement callback split between query and form body', () => {
    expect(parseWidgetCallback(
      { DOMAIN: 'mebelkz.bitrix24.kz', PLACEMENT: 'CRM_DEAL_DETAIL_TAB' },
      { ...callback, PLACEMENT_OPTIONS: JSON.stringify({ ID: 8204 }) },
    )).toMatchObject({
      domain: 'mebelkz.bitrix24.kz',
      dealId: '8204',
      placement: 'CRM_DEAL_DETAIL_TAB',
      status: 'L',
    });
  });

  it('fails closed when query and body disagree', () => {
    expect(() => parseWidgetCallback(
      { DOMAIN: 'mebelkz.bitrix24.kz', PLACEMENT: 'CRM_DEAL_DETAIL_TAB' },
      {
        ...callback,
        DOMAIN: 'other.bitrix24.kz',
        PLACEMENT_OPTIONS: JSON.stringify({ ID: 8204 }),
      },
    )).toThrowError(expect.objectContaining({ code: 'BITRIX24_WIDGET_CALLBACK_CONFLICT' }));
  });

  it('requires all financial, placement, and user scopes', () => {
    expect(() => parseWidgetCallback(
      { DOMAIN: 'mebelkz.bitrix24.kz', PLACEMENT: 'CRM_DEAL_DETAIL_TAB' },
      {
        ...callback,
        APPLICATION_SCOPE: 'crm,sale,pay_system',
        PLACEMENT_OPTIONS: JSON.stringify({ ID: 8204 }),
      },
    )).toThrowError(expect.objectContaining({ code: 'BITRIX24_WIDGET_SCOPE_MISSING' }));
  });

  it('validates date, two-decimal amount, authorization, and stable hash', () => {
    const body = parseCreateWidgetPaymentInput({
      amount: '50000.00',
      paymentDate: '2026-09-03',
      paySystemId: 14,
      comment: null,
      expectedOrderVersion: 12,
      confirmOverpayment: false,
    });
    expect(requestHash(body)).toHaveLength(64);
    expect(parseWidgetAuthorization(`BitrixWidget ${'a'.repeat(43)}`)).toBe('a'.repeat(43));
    expect(() => parseCreateWidgetPaymentInput({ ...body, paymentDate: '2026-02-31' }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parseCreateWidgetPaymentInput({ ...body, amount: '1' }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('parses final app callback without exposing an application token', () => {
    expect(parseRuntimeAuth({ auth: {
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
      domain: 'mebelkz.bitrix24.kz',
      member_id: 'member-12345678',
      status: 'L',
    } })).toMatchObject({ domain: 'mebelkz.bitrix24.kz', status: 'L' });
  });

  it('validates stale-safe administrative ambiguity resolution', () => {
    expect(parseResolvePaymentAmbiguityInput({
      resolution: 'attach_existing',
      bitrixPaymentId: '1038',
      reason: 'Проверено вручную в сделке',
      expectedVersion: 4,
    })).toMatchObject({ resolution: 'attach_existing', bitrixPaymentId: '1038' });
    expect(() => parseResolvePaymentAmbiguityInput({
      resolution: 'confirm_absent',
      reason: 'short',
      expectedVersion: 4,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
