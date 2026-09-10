import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

// Explicit opt-in container; no credentials or persistent fixtures. Run under
// rtk-heavy-guard. PREPARE must infer its own types to reproduce production 42P08.
const container = process.env.ERP_WIDGET_SQL_CANARY_CONTAINER;
describe.skipIf(!container)('Bitrix payment INSERT on real PostgreSQL', () => {
  it.each([false, true])('persists a bigint actor with confirmation=%s', async (confirmOverpayment) => {
    let insert = '';
    let params: unknown[] = [];
    const captured = new Error('captured before write');
    const tx = { query: vi.fn(async (sql: string, values: unknown[]) => {
      if (!sql.includes('INSERT INTO bitrix24_manual_payment_command')) return { rows: [] };
      insert = sql; params = values; throw captured;
    }) };
    const audit = { record: vi.fn() };
    const repository = new Bitrix24PaymentWidgetRepository({ transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } as never, audit as never);
    await expect(repository.createCommand({
      actorDisplayName: 'Actual widget creator',
      idempotencyKey: '11111111-1111-4111-8111-111111111111', requestHash: 'a'.repeat(64),
      session: { sessionId: 'test-session', memberId: 'test-member', domain: 'bitrix.example', dealId: '9860', bitrixUserId: '1', erpUserId: 2147483650, accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic', accessTokenExpiresAt: new Date('2026-09-09T03:00:00Z') },
      installation: { memberId: 'test-member', domain: 'bitrix.example', applicationTokenHash: 'b'.repeat(64), executorBitrixUserId: '1', accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic', accessTokenExpiresAt: new Date('2026-09-09T03:00:00Z') },
      deal: { dealId: '9860', requestId: null, requestState: null, orderId: 11634, orderKind: 'production_order', orderVersion: 12, finalAmount: '0.00', paidAmount: '0.00', managerId: 2147483650, createdBy: 2147483650, hasActivePositions: true },
      amount: '5000.00', currencyId: 'KZT', paymentDate: '2026-09-09',
      paySystem: { paySystemId: 14, name: 'Тест наличные', typePaidId: 1, isDefault: true },
      comment: 'E2E-Test SQL typing', confirmOverpayment,
      callerAccessTokenCiphertext: 'synthetic', callerRefreshTokenCiphertext: 'synthetic',
      callerAccessTokenExpiresAt: new Date('2026-09-09T03:00:00Z'), originatingRequestId: 'E2E-Test-SQL',
    })).rejects.toBe(captured);
    expect(audit.record).not.toHaveBeenCalled();
    expect(insert).toContain('RETURNING *');
    const literal = (value: unknown): string => value === null ? 'NULL'
      : typeof value === 'boolean' || typeof value === 'number' ? String(value)
      : `'${String(value instanceof Date ? value.toISOString() : value).replaceAll("'", "''")}'`;
    const sql = `BEGIN;
SET LOCAL statement_timeout='10s';
CREATE TEMP TABLE bitrix24_manual_payment_command (LIKE public.bitrix24_manual_payment_command INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
ALTER TABLE bitrix24_manual_payment_command ADD COLUMN IF NOT EXISTS bitrix_actor_name varchar(300);
PREPARE widget_payment_insert AS ${insert};
EXECUTE widget_payment_insert(${params.map(literal).join(',')});
DO $check$ BEGIN
IF NOT EXISTS (SELECT 1 FROM bitrix24_manual_payment_command WHERE bitrix_actor_name='Actual widget creator') THEN RAISE EXCEPTION 'widget author missing'; END IF;
IF NOT EXISTS (SELECT 1 FROM bitrix24_manual_payment_command WHERE erp_actor_user_id=2147483650 AND amount=5000.00 AND status='processing' AND overpayment_confirmed=${confirmOverpayment} AND ${confirmOverpayment ? 'overpayment_confirmed_by=2147483650 AND overpayment_confirmed_at IS NOT NULL' : 'overpayment_confirmed_by IS NULL AND overpayment_confirmed_at IS NULL'}) THEN RAISE EXCEPTION 'actor/confirmation persistence mismatch'; END IF;
END $check$;
ROLLBACK;`;
    const result = spawnSync('docker', ['exec', '-i', container!, 'sh', '-lc', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'], { input: sql, encoding: 'utf8', timeout: 20000 });
    // Never echo RETURNING *: it includes synthetic ciphertext columns.
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
