import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { bitrixAuditQuery } from './Bitrix24Audit';
describe('Bitrix journal queries', () => {
  it('keeps integration scope even when filters reset', () => {
    expect(bitrixAuditQuery({}, 1, 50)).toMatchObject({
      scope: 'bitrix24',
      page: 1,
      pageSize: 50,
    });
    expect(bitrixAuditQuery({}, 1, 50).excludeBitrix24).toBeUndefined();
  });
  it('searches order primary/related dimensions through orderIds and keeps typed Bitrix IDs', () => {
    const query = bitrixAuditQuery(
      {
        orderId: 11697,
        bitrixObject: 'deal',
        bitrixId: '9960',
        bitrixReconcile: 'exclude',
        range: [dayjs('2026-09-01'), dayjs('2026-09-18')],
      },
      2,
      25
    );
    expect(query).toMatchObject({
      orderIds: [11697],
      bitrixObject: 'deal',
      bitrixId: '9960',
      bitrixReconcile: 'exclude',
      page: 2,
    });
    expect(query.createdFrom).toMatch(/^2026-09-01/);
  });
});
