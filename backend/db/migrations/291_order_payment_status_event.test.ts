import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '291_order_payment_status_event.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');

describe('migration 291: order.payment_status_changed from a trigger on orders.payment_status_id', () => {
  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('fires only on a real change of the payment status', () => {
    expect(code).toContain('AFTER UPDATE OF payment_status_id ON public.orders');
    expect(code).toContain('WHEN (OLD.payment_status_id IS DISTINCT FROM NEW.payment_status_id)');
  });

  it('reads only transaction-local context, never app.user_id', () => {
    expect(code).toContain("current_setting('erp.event_actor_user_id', true)");
    expect(code).toContain("current_setting('erp.event_correlation_id', true)");
    expect(code).toContain("current_setting('erp.request_id', true)");
    expect(code).not.toContain('app.user_id');
  });

  it('one key per transition; silent for emitted/suppressed, other order kinds and the trash', () => {
    expect(code).toContain("'order.payment_status_changed:' || NEW.order_id::text || ':' || gen_random_uuid()::text");
    expect(code).toContain("IF v_mode = 'emitted' THEN");
    expect(code).toContain('requires erp.payment_status_event_reason');
    expect(code).toContain("NEW.order_kind IS DISTINCT FROM 'production_order' OR COALESCE(NEW.delete_flag, false)");
  });
});
