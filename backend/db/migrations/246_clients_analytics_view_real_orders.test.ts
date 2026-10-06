import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '246_clients_analytics_view_real_orders.sql'), 'utf8');
const rollback = readFileSync(resolve(__dirname, '246_clients_analytics_view_real_orders_rollback.sql'), 'utf8');
const repository = readFileSync(resolve(__dirname, '../../src/modules/clients-read/adapters/pg-clients-analytics-repository.ts'), 'utf8');
const columns = (text: string) => {
  const select = text.slice(text.lastIndexOf(' SELECT c.client_id,'), text.lastIndexOf('   FROM clients c'));
  return [...select.matchAll(/(?:AS |c\.|pa\.|oa\.|pa2\.|lo\.)([a-z_0-9]+),?\s*$/gm)].map((match) => match[1]);
};

describe('migration 246: clients_analytics_view counts real orders', () => {
  it('is one transaction with bounded lock waits and only replaces the view', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql.match(/CREATE OR REPLACE VIEW public\.clients_analytics_view AS/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DROP |ALTER |INSERT |UPDATE |DELETE |CONCURRENTLY/);
  });

  it('counts production orders only — in orders, in payments of orders and for the last order', () => {
    expect(sql.match(/o\.order_kind = 'production_order'::text/g)).toHaveLength(3);
  });

  it('tells «в работе» by the order status, not by the completion date', () => {
    expect(sql).not.toContain('completion_date IS NULL');
    expect(sql).toContain("AS orders_in_progress_count");
    expect(sql).toContain("os.order_status_code::text = ANY (ARRAY['legacy_7'::text, 'legacy_8'::text])) AS orders_completed_count");
    expect(sql).toContain("LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id");
    // an order without a status row is «в работе», never lost from both counters
    expect(sql).toContain('os.order_status_code IS NULL OR');
    expect(sql).toContain("RAISE EXCEPTION 'migration 246: order statuses legacy_7 («Выдан») and legacy_8 («Завершен») are required'");
  });

  it('uses the same rules as the backend clients analytics', () => {
    expect(repository).toContain("const HANDED_OVER_STATUS_CODES = ['legacy_7', 'legacy_8'] as const;");
    expect(repository).toContain("o.delete_flag = false AND o.order_kind = 'production_order'");
  });

  it('the debt of a client is the same net sum the client card reports', () => {
    // two orders of 100, one paid 200 and one unpaid: the list, the «С долгом» set and the card all say 0
    expect(sql).toContain('sum(COALESCE(o.final_amount, COALESCE(o.total_amount, 0::numeric)) - COALESCE(o.paid_amount, 0::numeric)) AS debt_sum');
    expect(repository).toContain("const balance = `${AMOUNT} - ${PAID}`;");
    expect(repository).toContain('${money(`sum(${balance})`)} AS debt');
  });

  it('keeps the columns: the rollback restores the previous definition with the same list', () => {
    expect(columns(sql).length).toBeGreaterThan(30);
    expect(columns(sql)).toEqual(columns(rollback));
    expect(rollback).toContain('count(*) FILTER (WHERE o.completion_date IS NULL) AS orders_in_progress_count');
    expect(rollback).not.toContain('production_order');
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '246_clients_analytics_view_real_orders.sql';");
  });
});
