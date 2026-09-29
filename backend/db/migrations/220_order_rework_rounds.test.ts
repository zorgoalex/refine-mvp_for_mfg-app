import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./220_order_rework_rounds.sql', import.meta.url), 'utf8');
const sql098 = readFileSync(new URL('./098_order_realtime_producer_bridge.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

function emitOneBody(source: string): string {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION order_realtime_emit_one(');
  const end = source.indexOf('$$;', source.indexOf('AS $$', start));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('220 order rework rounds migration (A)', () => {
  it('runs as one transaction', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('adds the rework status only by code, bumping a drifted identity first', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.order_statuses WHERE order_status_code = 'rework'\)/);
    expect(sql).toContain("pg_get_serial_sequence('public.order_statuses', 'order_status_id')");
    expect(sql).toMatch(/'rework',\s*'Переделка',\s*45,/);
  });

  it('seeds reasons idempotently, including the system «Уточнить»', () => {
    expect(sql).toMatch(/\('unclarified', 'Уточнить', false, true, 100\)/);
    expect(sql).toMatch(/\('other', 'Другое', true, false, 90\)/);
    expect(sql).toContain('ON CONFLICT (code) DO NOTHING');
  });

  it('allows at most one open round per order and never reuses round numbers', () => {
    expect(sql).toMatch(/uq_order_production_rounds_open[\s\S]*?\(order_id\)\s*WHERE closed_at IS NULL/);
    expect(sql).toContain('CONSTRAINT uq_order_production_rounds_order_round UNIQUE (order_id, round_no)');
    expect(sql).toContain('production_round <= last_round_no');
  });

  it('keeps the old stage-event unique indexes (dropped by migration B only)', () => {
    expect(sql).not.toMatch(/DROP INDEX[\s\S]*uq_pse_(detail|order)_status_once/);
    expect(sql).toMatch(/uq_pse_detail_status_round[\s\S]*?\(detail_id, production_status_id, round_no\)/);
    expect(sql).toMatch(/uq_pse_order_status_round[\s\S]*?\(order_id, production_status_id, round_no\)/);
  });

  it('is additive: no destructive statements outside trigger re-creation', () => {
    // Function/DO bodies are excluded: emit_one legitimately UPDATEs the stream row.
    const topLevel = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$ $$');
    const withoutTriggerDrops = topLevel.replace(/DROP TRIGGER IF EXISTS [a-z_]+ ON public\.[a-z_]+;/g, '');
    expect(withoutTriggerDrops).not.toMatch(/\bDROP\b/i);
    expect(topLevel).not.toMatch(/^\s*(UPDATE|DELETE)\s+/im);
  });

  it('pre-creates realtime stream rows so the deferred drain never inserts one', () => {
    expect(sql).toMatch(/INSERT INTO public\.order_realtime_stream \(order_id\)\s*SELECT order_id FROM public\.orders\s*ON CONFLICT \(order_id\) DO NOTHING/);
    expect(sql).toMatch(/CREATE TRIGGER trg_order_realtime_stream_on_order_insert\s*AFTER INSERT ON public\.orders/);
  });

  it('emit_one without erp.realtime_defer is byte-identical to 098', () => {
    const body220 = emitOneBody(sql);
    const deferBlock = body220.slice(
      body220.indexOf('  -- Операции кругов «Переделки» не берут stream'),
      body220.indexOf('  INSERT INTO order_realtime_stream (order_id)'),
    );
    expect(deferBlock).toContain("current_setting('erp.realtime_defer', true)");
    expect(deferBlock).toContain('INSERT INTO order_realtime_deferred');
    expect(deferBlock).toContain('RETURN false;');
    expect(body220.replace(deferBlock, '')).toBe(emitOneBody(sql098));
    expect(sql).toContain("IS 'order-realtime-producer-bridge-v1'");
  });

  it('guards entry into rework and the status/open-round consistency on commit', () => {
    expect(sql).toContain("NOT IN ('on', 'import')");
    expect(sql).toContain('ORDER_REWORK_REQUIRES_COMMAND');
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF order_status_id ON public\.orders/);
    expect(sql).toMatch(/v_code IN \('legacy_6', 'legacy_7', 'legacy_8'\)/);
    expect(sql).toContain('ORDER_REWORK_STATUS_WITHOUT_ROUND');
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER ctrg_orders_rework_round_consistency[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER ctrg_order_production_rounds_consistency\s*AFTER INSERT OR UPDATE OR DELETE ON public\.order_production_rounds\s*DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/TG_OP IN \('UPDATE', 'DELETE'\) THEN\s*PERFORM public\.assert_order_rework_round_consistency\(OLD\.order_id\)/);
  });

  it('is probed before the ledger records it, and 098 accepts the redefined emit_one', () => {
    expect(runner).toContain('220_order_rework_rounds*) probe_all');
    expect(runner).toContain("q_fun_hash 'order_realtime_emit_one(bigint,text[],bigint[],text)' 04eabdca6d8369194f6937ca6d1b1fc6");
    expect(runner).toContain("q_fun_hash_either 'order_realtime_emit_one(bigint,text[],bigint[],text)' bbf8a2f2fad9cd1483a144244fe9d522 04eabdca6d8369194f6937ca6d1b1fc6");
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/220_order_rework_rounds\*\)\s+probe_file "\$f" \|\| die/);
  });
});
