import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./212_order_rework_round_closure.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('212 order rework round closure migration', () => {
  it('closes the open round on ready/issued/completed from any writer, in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/WHEN 'legacy_6' THEN 'ready'\s*WHEN 'legacy_7' THEN 'issued'\s*WHEN 'legacy_8' THEN 'completed'/);
    expect(sql).toMatch(/AFTER UPDATE OF order_status_id ON public\.orders/);
    expect(sql).toContain('WHERE order_id = NEW.order_id AND closed_at IS NULL');
  });

  it('records audit (with detail links) and an idempotent outbox event once per round', () => {
    expect(sql).toContain("'order.rework_closed'");
    expect(sql).toContain("format('order:%s:rework:%s:closed:%s', NEW.order_id, v_round.round_no, v_round.event_seq)");
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(sql).toContain("INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)");
    expect(sql).toContain("'txid', txid_current()");
    expect(sql).not.toContain("current_setting('app.user_id'");
    expect(sql).toContain("'db-order-rework-close:' || txid_current()::TEXT");
    expect(sql).toContain('closed_by = NULL');
  });

  it('is probed before the ledger records it', () => {
    expect(runner).toContain('212_order_rework_round_closure*) probe_all');
    expect(runner).toContain("q_fun_hash 'public.trg_orders_close_rework_round()' b5591f65ae646e55dd5232ad77f8cac7");
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/212_order_rework_round_closure\*\)\s+probe_file "\$f" \|\| die/);
  });
});
