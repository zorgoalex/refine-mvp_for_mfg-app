import { describe, expect, it } from 'vitest';
import {
  parseBitrix24InboundEvent,
  parseBitrix24InstallationPayload,
} from './bitrix24-reverse-payload';

describe('Bitrix24 reverse callback payloads', () => {
  it('parses an installation callback', () => {
    expect(parseBitrix24InstallationPayload({
      auth: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: '3600',
        domain: 'MEBELKZ.BITRIX24.KZ',
        member_id: 'member-123456',
        status: 'L',
        application_token: 'application-secret',
      },
    })).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
      domain: 'mebelkz.bitrix24.kz',
      memberId: 'member-123456',
      applicationToken: 'application-secret',
    });
  });

  it('normalizes an event and strips callback tokens from persisted payload', () => {
    const event = parseBitrix24InboundEvent({
      event: 'onCrmDealUpdate',
      data: { FIELDS: { ID: '8204' } },
      ts: '1785305270',
      auth: {
        domain: 'mebelkz.bitrix24.kz',
        member_id: 'member-123456',
        application_token: 'application-secret',
        access_token: 'must-not-persist',
        refresh_token: 'must-not-persist',
      },
    }, new Date('2026-08-01T00:00:00Z'));

    expect(event).toMatchObject({
      eventName: 'ONCRMDEALUPDATE',
      objectType: 'deal',
      operation: 'upsert',
      bitrixId: '8204',
    });
    expect(JSON.stringify(event.storedPayload)).not.toContain('token');
  });

  it('rejects unsupported events and future timestamps', () => {
    expect(() => parseBitrix24InboundEvent({
      event: 'ONCRMUNKNOWN',
      data: { FIELDS: { ID: '1' } },
      ts: '1',
      auth: {
        domain: 'mebelkz.bitrix24.kz',
        member_id: 'member-123456',
        application_token: 'application-secret',
      },
    })).toThrow('Unsupported Bitrix24 event');

    expect(() => parseBitrix24InboundEvent({
      event: 'ONCRMCONTACTADD',
      data: { FIELDS: { ID: '1' } },
      ts: '2000000000',
      auth: {
        domain: 'mebelkz.bitrix24.kz',
        member_id: 'member-123456',
        application_token: 'application-secret',
      },
    }, new Date('2026-01-01T00:00:00Z'))).toThrow('future');
  });
});
