import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

const actorId = 2147483650;
const commandId = '5ba24311-d20d-4d97-bea2-1d356eaef707';

function setup(options: { completed?: boolean; denied?: boolean; existingPayment?: boolean } = {}) {
  const command = {
    command_id: commandId, status: options.completed ? 'completed' : 'awaiting_erp_retry',
    erp_actor_user_id: actorId, bitrix_actor_user_id: '17', bitrix_executor_user_id: '1',
    request_id: null, erp_order_id: 11634, expected_order_version: 12,
    bitrix_payment_id: '8322', erp_payment_id: null, amount: '1000.00', currency_id: 'KZT',
    payment_date: '2026-09-15', type_paid_id: 61, pay_system_id: 18,
    originating_request_id: 'E2E-Test-widget-actor', version: 1,
  };
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql.startsWith('SELECT * FROM bitrix24_manual_payment_command')) return { rows: [command], rowCount: 1 };
    if (sql.includes('SELECT orders.order_kind')) return { rows: [{ order_kind: 'production_order', version: 12, final_amount: '16800.00', payment_status_id: 1, manager_id: 3, created_by: 86, has_positions: true }], rowCount: 1 };
    if (sql.includes('FROM users actor')) return { rows: [], rowCount: options.denied ? 0 : 1 };
    if (sql.includes('SELECT bitrix_payment_id, amount')) return { rows: [{ bitrix_payment_id: '8322', amount: '1000.00', currency_id: 'KZT', paid: true, payment_local_date: '2026-09-15', normalized_hash: 'a'.repeat(64), state: 'active', erp_payment_id: options.existingPayment ? 9001 : null }], rowCount: 1 };
    if (sql.includes('COALESCE(SUM(amount)')) return { rows: [{ paid_amount: '6000.00', payment_date: '2026-09-15' }], rowCount: 1 };
    if (sql.includes('INSERT INTO payments')) return { rows: [{ payment_id: 9001 }], rowCount: 1 };
    if (sql.includes("SET status='completed'")) return { rows: [{ ...command, status: 'completed', erp_payment_id: 9001 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const audit = { record: vi.fn() };
  const repository = new Bitrix24PaymentWidgetRepository({ transaction: (fn: (tx: { query: typeof query }) => unknown) => fn({ query }) } as never, audit as never);
  return { repository, query, audit };
}

describe('Widget payment materialization actor', () => {
  it.each([false, true])('uses the original authorized ERP actor on retry; existing payment=%s', async (existingPayment) => {
    const { repository, query, audit } = setup({ existingPayment });
    const result = await repository.materializeCommand(commandId);
    expect(result.status).toBe('completed');
    const calls = query.mock.calls;
    const actorIndex = calls.findIndex(([sql]) => sql.includes("set_config('app.user_id'"));
    const authIndex = calls.findIndex(([sql]) => sql.includes('FROM users actor'));
    const writeIndex = calls.findIndex(([sql]) => sql.includes(existingPayment ? 'UPDATE payments SET' : 'INSERT INTO payments'));
    expect(actorIndex).toBeGreaterThan(authIndex);
    expect(writeIndex).toBeGreaterThan(actorIndex);
    expect(calls[actorIndex]).toEqual(["SELECT set_config('app.user_id', $1, true)", [String(actorId)]]);
    expect(calls.filter(([sql]) => sql.includes('INSERT INTO payments'))).toHaveLength(existingPayment ? 0 : 1);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: actorId, relatedPaymentId: 9001, event: 'bitrix24.widget_payment.materialized' }));
  });

  it('does not change audit context or payments for a completed command', async () => {
    const { repository, query, audit } = setup({ completed: true });
    await repository.materializeCommand(commandId);
    expect(query.mock.calls.some(([sql]) => sql.includes("'app.user_id'"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO payments'))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails closed when the original actor loses permission', async () => {
    const { repository, query, audit } = setup({ denied: true });
    await expect(repository.materializeCommand(commandId)).rejects.toMatchObject({ code: 'BITRIX24_WIDGET_PERMISSION_DENIED' });
    expect(query.mock.calls.some(([sql]) => sql.includes("'app.user_id'") || sql.includes('INSERT INTO payments'))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

const container = process.env.ERP_WIDGET_SQL_CANARY_CONTAINER;
describe.skipIf(!container)('Widget payment audit trigger on PostgreSQL', () => {
  it.each([false, true])('executes repository INSERT with transaction actor enabled=%s', async (withActor) => {
    const { repository, query } = setup();
    await repository.materializeCommand(commandId);
    const relevant = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO payments') || (withActor && sql.includes("set_config('app.user_id'")));
    const literal = (value: unknown) => typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    const statements = relevant.map(([sql, params], index) => `PREPARE stmt${index} AS ${sql}; EXECUTE stmt${index}(${(params ?? []).map(literal).join(',')});`).join('\n');
    // Isolated temporary table: real payment shape + real production audit
    // trigger; independent identity sequence, no persistent rows or API calls.
    const sql = `\\set VERBOSITY verbose
BEGIN;
SET LOCAL statement_timeout='10s';
SELECT set_config('app.user_id', '', false);
CREATE TEMP TABLE payments (LIKE public.payments INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS) ON COMMIT DROP;
CREATE TRIGGER test_created_by BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION public.set_created_by();
${statements}
DO $check$ BEGIN
IF NOT EXISTS (SELECT 1 FROM payments WHERE created_by=${actorId} AND type_paid_id=61 AND amount=1000.00) THEN RAISE EXCEPTION 'E2E-Test widget payment author mismatch'; END IF;
END $check$;
COMMIT;
DO $check$ BEGIN
IF NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN RAISE EXCEPTION 'E2E-Test actor leaked past commit'; END IF;
END $check$;`;
    const result = spawnSync('docker', ['exec', '-i', container!, 'sh', '-lc', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -q'], { input: sql, encoding: 'utf8', timeout: 20000 });
    expect(result.error).toBeUndefined();
    if (withActor) expect(result.status, result.stderr).toBe(0);
    else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('23502');
      expect(result.stderr).toContain('created_by');
    }
  });
});
