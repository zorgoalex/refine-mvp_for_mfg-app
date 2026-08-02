import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'order-detail-transfer.service.ts'), 'utf8');

describe('order detail transfer target list contract', () => {
  it('lists last-month orders and prioritizes targets with the source client', () => {
    expect(source).toContain("o.order_date >= (CURRENT_DATE - INTERVAL '1 month')");
    expect(source).toContain('LEFT JOIN clients c ON c.client_id = o.client_id');
    expect(source).toContain('CASE WHEN o.client_id = $3 THEN 0 ELSE 1 END');
    expect(source).not.toContain('AND o.client_id = $1');
  });

  it('returns display fields required by the target-order selector', () => {
    expect(source).toContain('clientId: toNumber(row.client_id)');
    expect(source).toContain('clientName: row.client_name');
    expect(source).toContain('orderDate: dateOnly(row.order_date)');
    expect(source).toContain('orderStatusName: row.order_status_name');
  });
});
