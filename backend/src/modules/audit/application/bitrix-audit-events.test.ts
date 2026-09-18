import { describe, expect, it } from 'vitest';
import { bitrixEventDefinition, isBitrixAuditEvent } from './bitrix-audit-events';
import { sanitizeBitrixAudit } from './bitrix-audit-sanitization';
import { parseAuditListQuery, parseAuditFilterOptionsQuery } from '../http/audit.controller';
import { parseBitrixQueueQuery } from '../http/bitrix-audit.controller';

describe('Bitrix audit ownership and safe queries', () => {
  it.each([['crm_sync.upsert', null], ['bitrix24_reverse.future', null], ['bitrix24.future', null], ['orders.update', 'backend-bitrix24'], ['project.created', 'bitrix24'], ['unknown', 'bitrix24-widget']])('includes owned %s / %s', (event, source) => expect(isBitrixAuditEvent(event, source)).toBe(true));
  it.each([['orders.update', null], ['payments.create', 'backend'], ['project.created', 'backend'], ['crmXsync.upsert', null], ['other.bitrix24.failed', ''], ['unknown', 'backend-bitrix24-fake'], [null, null]])('does not hide unrelated %s / %s', (event, source) => expect(isBitrixAuditEvent(event, source)).toBe(false));
  it('does not call retry_failed a failed retry', () => {
    expect(bitrixEventDefinition('bitrix24_reverse.retry_failed').outcome).toBe('started');
    expect(bitrixEventDefinition('bitrix24.future').outcome).toBe('unknown');
    expect(bitrixEventDefinition('crm_sync.upsert', 'order').category).toBe('order');
  });
  it('sanitizes Bitrix paths, assignments, JSON keys and existing token shapes', () => {
    const result = JSON.stringify(sanitizeBitrixAudit({ auth: 'SECRET1', APP_SID: 'SECRET2', access_token: 'SECRET3', error: 'https://example.invalid/rest/1/SECRET4/event.get?auth=SECRET5&APP_SID=SECRET6 Authorization: Bearer SECRET7', nested: [{ error: '"auth":"SECRET8"' }] }));
    expect(result).not.toMatch(/SECRET[1-8]/);
    expect(result).toContain('[REDACTED]');
  });
  it('keeps existing API inclusive unless explicitly excluded', () => {
    expect(parseAuditListQuery({}).filters).toEqual({});
    expect(parseAuditListQuery({ excludeBitrix24: 'false' }).filters.excludeBitrix24).toBe(false);
    expect(parseAuditFilterOptionsQuery({ scope: 'business', excludeBitrix24: 'true' })).toEqual({ scope: 'business', excludeBitrix24: true });
  });
  it.each([{ scope: 'bitrix24', excludeBitrix24: 'true' }, { excludeBitrix24: 'yes' }, { bitrixDirection: 'reverse' }, { scope: 'bitrix24', bitrixId: '42' }])('rejects contradictory/unsafe filters %o', (query) => expect(() => parseAuditListQuery(query)).toThrow());
  it('validates queue typed identities and limit', () => {
    expect(() => parseBitrixQueueQuery({ direction: 'forward', bitrixId: '42' })).toThrow();
    expect(() => parseBitrixQueueQuery({ direction: 'forward', pageSize: 201 })).toThrow();
    expect(parseBitrixQueueQuery({ direction: 'forward', orderId: '11697' })).toMatchObject({ orderId: 11697, page: 1, pageSize: 50 });
  });
});
