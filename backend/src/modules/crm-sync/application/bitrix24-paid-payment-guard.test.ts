import { describe, expect, it } from 'vitest';
import { Bitrix24ApiError, type Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type {
  BeginPaidPaymentOperation,
  PaidPaymentOperation,
  PaidPaymentOutcome,
} from '../adapters/pg-crm-sync-paid-payment-operation-repository';
import {
  Bitrix24PaidPaymentGuard,
  type PaidPaymentOperationStore,
  type PaidPaymentStartPolicy,
} from './bitrix24-paid-payment-guard';
import { mapPayment, paymentXmlId } from './bitrix24-sync-mapper';
import type { PaymentRow } from './crm-sync.types';

const options = { erpBaseUrl: 'https://erp.example', currencyId: 'KZT', assignedById: 1, paySystemId: 6 };
const EVENT = '11111111-1111-4111-8111-111111111111';

interface RemoteState { paid: 'Y' | 'N'; sum: number; currency: string; xmlId: string | null; paySystemId?: number }

/** Bitrix24 as the portal behaves: a paid payment keeps its amount and cannot be deleted. */
function fakeBitrix(initial: Record<string, RemoteState>) {
  const payments = new Map(Object.entries(initial).map(([id, state]) => [id, { ...state }]));
  const calls: string[] = [];
  const paySystems: unknown[] = [];
  const failures: Array<{ match: (call: string) => boolean; error?: Error }> = [];
  const maybeFail = (call: string) => {
    const index = failures.findIndex((failure) => failure.match(call));
    if (index >= 0) {
      const [failure] = failures.splice(index, 1);
      throw failure.error ?? new Bitrix24ApiError('net', 'NETWORK_ERROR', 0, 'fetch failed');
    }
  };
  const bitrix = {
    withRequestGuard: async (guard: () => Promise<void>, operation: () => Promise<unknown>) => {
      await guard();
      return operation();
    },
    getPayment: async (id: string) => {
      calls.push(`get:${id}`);
      maybeFail(`get:${id}`);
      const payment = payments.get(id);
      if (!payment) throw new Bitrix24ApiError('sale.payment.get', 'ERROR_NOT_FOUND', 400, 'payment not found');
      return { ...payment };
    },
    updatePayment: async (id: string, fields: Record<string, unknown>) => {
      const call = `update:${id}:${fields.paid ?? '-'}:${fields.sum ?? '-'}`;
      calls.push(call);
      maybeFail(call);
      paySystems.push(fields.paySystemId);
      const payment = payments.get(id);
      if (!payment) throw new Bitrix24ApiError('sale.payment.update', 'ERROR_NOT_FOUND', 400, 'payment not found');
      // The portal rejects any sale.payment.update without paySystemId (production 15.10).
      if (fields.paySystemId === undefined) {
        throw new Bitrix24ApiError('sale.payment.update', '0', 400, 'Required fields: paySystemId');
      }
      if (payment.paid === 'Y' && fields.sum !== undefined && Number(fields.sum) !== payment.sum) {
        throw new Bitrix24ApiError('sale.payment.update', '0', 400, 'Нельзя изменить сумму оплаты, если установлен статус "Оплачено"');
      }
      if (fields.sum !== undefined) payment.sum = Number(fields.sum);
      if (fields.paid !== undefined) payment.paid = fields.paid as 'Y' | 'N';
      if (fields.xmlId !== undefined) payment.xmlId = String(fields.xmlId);
    },
    deletePayment: async (id: string) => {
      calls.push(`delete:${id}`);
      maybeFail(`delete:${id}`);
      const payment = payments.get(id);
      if (!payment) return;
      if (payment.paid === 'Y') {
        throw new Bitrix24ApiError('crm.item.payment.delete', 'SALE_PAYMENT_DELETE_EXIST_PAID', 400, 'Оплата оплачена. Отмените оплату');
      }
      payments.delete(id);
    },
  } as unknown as Bitrix24ApiPort;
  return { bitrix, payments, calls, failures, paySystems };
}

function memoryStore() {
  const operations = new Map<string, PaidPaymentOperation & { outcome?: PaidPaymentOutcome; reproject?: boolean }>();
  const audits: string[] = [];
  const domainEvents: string[] = [];
  let sequence = 0;
  const store: PaidPaymentOperationStore & { crashAfterComplete?: boolean; failCardAudit?: string } = {
    async findOpen(erpPaymentId) {
      return [...operations.values()].find((op) => op.erpPaymentId === erpPaymentId && op.phase !== 'completed') ?? null;
    },
    async listDue() {
      return [...operations.values()].filter((op) => op.phase !== 'completed');
    },
    async listOpenFor(orderId, paymentIds) {
      return [...operations.values()].filter((op) =>
        op.phase !== 'completed' && (op.erpOrderId === orderId || paymentIds.includes(op.erpPaymentId)));
    },
    async begin(input: BeginPaidPaymentOperation) {
      const open = await this.findOpen(input.erpPaymentId);
      if (open) return open;
      const op: PaidPaymentOperation = {
        operationId: `op-${++sequence}`,
        erpPaymentId: input.erpPaymentId,
        erpOrderId: input.erpOrderId,
        bitrixPaymentId: input.bitrixPaymentId,
        bitrixDealId: input.bitrixDealId,
        action: input.action,
        phase: 'requested',
        attempts: 0,
        stuckAt: null,
        originOutboxEventId: input.originOutboxEventId,
        bitrixSumBefore: input.bitrixSumBefore,
        targetSum: input.targetSum,
      };
      operations.set(op.operationId, op);
      audits.push(`requested:${op.erpPaymentId}`);
      return { ...op };
    },
    async markUnpaid(op) {
      const stored = operations.get(op.operationId)!;
      if (stored.phase !== 'unpaid') audits.push(`unpaid:${op.erpPaymentId}`);
      stored.phase = 'unpaid';
      return { ...stored };
    },
    async switchToDelete(op) {
      const stored = operations.get(op.operationId)!;
      stored.action = 'delete';
      stored.targetSum = null;
      audits.push(`action_changed:${op.erpPaymentId}`);
      return { ...stored };
    },
    async complete(op, outcome, { reproject }) {
      const stored = operations.get(op.operationId)!;
      if (stored.phase === 'completed') return false;
      stored.phase = 'completed';
      stored.outcome = outcome;
      stored.reproject = reproject;
      stored.stuckAt = null;
      audits.push(`completed:${op.erpPaymentId}:${outcome}`);
      domainEvents.push(`completed:${op.operationId}`);
      return true;
    },
    async recordFailure(op) {
      const stored = operations.get(op.operationId);
      if (!stored || stored.phase === 'completed') return;
      stored.attempts += 1;
      if (stored.attempts >= 5 && stored.stuckAt === null) {
        stored.stuckAt = new Date().toISOString();
        audits.push(`stuck:${op.erpPaymentId}`);
        domainEvents.push(`stuck:${op.operationId}`);
      }
    },
    async recordPaymentCards(op, result) {
      if (store.failCardAudit === result.stage) throw new Error(`audit failure ${result.stage}`);
      audits.push(`card_${result.stage}:${op.erpPaymentId}:${result.cardIds.join(',')}:${result.cardSums.join(',')}`
        + `→${result.appliedSum}${result.error === null ? '' : `:${result.error}`}`);
    },
  };
  return { store, operations, audits, domainEvents };
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    paymentId: '3',
    orderId: '2',
    typePaidId: '1',
    typePaidName: 'Наличные',
    amount: 300,
    paymentDate: '2026-08-03',
    notes: null,
    ...overrides,
  };
}

function setup(input: {
  remote: Record<string, RemoteState>;
  erpPayments?: PaymentRow[];
  policy?: Partial<PaidPaymentStartPolicy>;
}) {
  const fake = fakeBitrix(input.remote);
  const memory = memoryStore();
  const erp = new Map((input.erpPayments ?? [payment()]).map((row) => [row.paymentId, row]));
  const policy: PaidPaymentStartPolicy = {
    enabled: input.policy?.enabled ?? true,
    orderIds: input.policy?.orderIds ?? new Set<string>(),
  };
  const guard = new Bitrix24PaidPaymentGuard({
    bitrix: fake.bitrix,
    store: memory.store,
    source: { getPaymentById: async (id) => erp.get(id) ?? null },
    options,
    policy: () => policy,
  });
  return { guard, ...fake, ...memory, erp, policy };
}

const ours = (paid: 'Y' | 'N', sum: number): RemoteState => ({ paid, sum, currency: 'KZT', xmlId: paymentXmlId('3') });
const fieldsOf = (row: PaymentRow) => mapPayment(row, options).fields;
const update = (env: ReturnType<typeof setup>, row = payment()) =>
  env.guard.update({ payment: row, dealId: '50', bitrixId: '700', fields: fieldsOf(row), requestId: EVENT });
const remove = (env: ReturnType<typeof setup>, bitrixId = '700') =>
  env.guard.delete({ erpPaymentId: '3', erpOrderId: '2', dealId: '50', bitrixId, requestId: EVENT });

describe('Bitrix24PaidPaymentGuard — update', () => {
  it('unpays, applies the new amount and pays back a paid ERP payment (1)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    await update(env);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect(env.calls).toEqual(['update:700:Y:300', 'get:700', 'get:700', 'update:700:N:-', 'get:700', 'update:700:Y:300']);
    expect(env.audits).toEqual(['requested:3', 'unpaid:3', 'completed:3:applied']);
    expect(env.domainEvents).toHaveLength(1);
    expect([...env.operations.values()][0]).toMatchObject({ reproject: false, originOutboxEventId: EVENT });
  });

  it('sends the payment\'s own pay system with the unpaid step (portal requires paySystemId, prod 15.10)', async () => {
    const env = setup({ remote: { 700: { ...ours('Y', 142000), paySystemId: 9 } } });
    await update(env);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    // full update (refused: paid lock) → unpaid step with the portal's pay system 9 → full update with config 6
    expect(env.paySystems).toEqual([6, 9, 6]);
    const fallback = setup({ remote: { 700: ours('Y', 142000) } });
    await update(fallback);
    expect(fallback.paySystems).toEqual([6, 6, 6]);
  });

  it('keeps the old error and starts nothing while the flag is off (2)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) }, policy: { enabled: false } });
    await expect(update(env)).rejects.toThrow('Нельзя изменить сумму');
    expect(env.operations.size).toBe(0);
    expect(env.calls).toEqual(['update:700:Y:300']);
  });

  it.each([
    ['another owner', { paid: 'Y', sum: 142000, currency: 'KZT', xmlId: 'MANAGER' } as RemoteState],
    ['no tag', { paid: 'Y', sum: 142000, currency: 'KZT', xmlId: null } as RemoteState],
    ['another currency', { ...ours('Y', 142000), currency: 'USD' }],
  ])('never unpays when Bitrix shows %s (3)', async (_label, remote) => {
    const env = setup({ remote: { 700: remote } });
    await expect(update(env)).rejects.toThrow('Нельзя изменить сумму');
    expect(env.operations.size).toBe(0);
    expect(env.calls.filter((call) => call.includes(':N:'))).toEqual([]);
  });

  it('does not treat a rejection with the same amount as a paid-lock (3)', async () => {
    const env = setup({ remote: { 700: ours('Y', 300) } });
    env.failures.push({
      match: (call) => call === 'update:700:Y:300',
      error: new Bitrix24ApiError('sale.payment.update', 'OTHER', 400, 'some other validation'),
    });
    await expect(update(env)).rejects.toThrow('some other validation');
    expect(env.operations.size).toBe(0);
  });

  it('rejects a non-positive ERP amount before unpaying (3)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) }, erpPayments: [payment({ amount: 0 })] });
    await expect(update(env, payment({ amount: 0 }))).rejects.toThrow('Нельзя изменить сумму');
    expect(env.operations.size).toBe(0);
  });

  it('leaves the operation unpaid on a permanent second-step error and recovery finishes it (4)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow('fetch failed');
    const op = [...env.operations.values()][0];
    expect(op).toMatchObject({ phase: 'unpaid', attempts: 1 });
    expect(env.payments.get('700')).toMatchObject({ paid: 'N' });

    const recovered = await env.guard.recoverDue(async () => undefined);
    expect(recovered).toEqual({ completed: 1, failed: 0 });
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect(op).toMatchObject({ phase: 'completed', outcome: 'applied', reproject: true });
  });

  it('flags stuck once after five failures, keeps the phase and clears it on success (12)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    for (let i = 0; i < 6; i++) env.failures.push({ match: (call) => call === 'get:700' && env.payments.get('700')!.paid === 'N' });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    for (let i = 0; i < 5; i++) await env.guard.recoverDue(async () => undefined);
    const op = [...env.operations.values()][0];
    expect(op.phase).toBe('unpaid');
    expect(op.stuckAt).not.toBeNull();
    expect(env.domainEvents.filter((event) => event.startsWith('stuck:'))).toHaveLength(1);

    await env.guard.recoverDue(async () => undefined);
    await env.guard.recoverDue(async () => undefined);
    expect(op).toMatchObject({ phase: 'completed', stuckAt: null });
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
  });

  it('continues from the observed state after a crash before the phase commit (5)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    const markUnpaid = env.store.markUnpaid.bind(env.store);
    env.store.markUnpaid = async () => { throw new Error('process died'); };
    await expect(update(env)).rejects.toThrow('process died');
    env.store.markUnpaid = markUnpaid;
    expect([...env.operations.values()][0].phase).toBe('requested');
    expect(env.payments.get('700')!.paid).toBe('N');

    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect([...env.operations.values()][0].phase).toBe('completed');
  });

  it('keeps the phase when the lease is lost between steps; the next owner finishes (6)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({
      match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N',
      error: new Error('crm-sync: ownership lost'),
    });
    await expect(update(env)).rejects.toThrow('ownership lost');
    expect([...env.operations.values()][0].phase).toBe('unpaid');
    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
  });

  it('a lost response of the full update, then a new ERP amount: unpays again instead of replaying (11)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    // Bitrix applies the full update but the response is lost.
    env.failures.push({
      match: (call) => {
        if (call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N') {
          env.payments.set('700', ours('Y', 300));
          return true;
        }
        return false;
      },
    });
    await expect(update(env)).rejects.toThrow('fetch failed');
    env.erp.set('3', payment({ amount: 450 }));

    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 450 });
    expect(env.calls.slice(-4)).toEqual(['get:700', 'update:700:N:-', 'get:700', 'update:700:Y:450']);
  });

  it('switches an open update to a delete when the ERP payment disappeared (10)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    env.erp.delete('3');
    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.has('700')).toBe(false);
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', outcome: 'deleted', action: 'delete' });
    expect(env.audits).toContain('action_changed:3');
  });

  it('reports remote_missing inline and reprojects when the payment vanishes after the check (R-code #3)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    const getPayment = env.bitrix.getPayment.bind(env.bitrix);
    let reads = 0;
    env.bitrix.getPayment = async (id: string) => {
      reads++;
      const result = await getPayment(id);
      if (reads === 1) env.payments.delete('700');
      return result;
    };
    await expect(update(env)).resolves.toBe('remote_missing');
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', outcome: 'remote_missing', reproject: true });
  });

  it('finishes an open operation before a new update of the same payment (settle first)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    await expect(update(env)).resolves.toBe('applied');
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', reproject: true });
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
  });

  it('completes as remote_missing when the payment is gone in Bitrix', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    env.payments.delete('700');
    await env.guard.recoverDue(async () => undefined);
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', outcome: 'remote_missing', reproject: true });
  });
});

describe('Bitrix24PaidPaymentGuard — delete', () => {
  it('unpays and deletes a paid ERP payment; a retry on the confirmed id is a success (7)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    await remove(env);
    expect(env.paySystems).toEqual([6]);
    expect(env.payments.has('700')).toBe(false);
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', outcome: 'deleted' });
    await remove(env);
    expect(env.operations.size).toBe(1);
  });

  it.each([
    ['paid, no tag', { paid: 'Y', sum: 5000, currency: 'KZT', xmlId: null } as RemoteState],
    ['unpaid, no tag (manager payment picked as a create-guard candidate)', { paid: 'N', sum: 5000, currency: 'KZT', xmlId: null } as RemoteState],
    ['unpaid, foreign tag', { paid: 'N', sum: 5000, currency: 'KZT', xmlId: paymentXmlId('99') } as RemoteState],
  ])('never deletes a payment without our exact tag: %s (7)', async (_label, remote) => {
    const env = setup({ remote: { 700: remote } });
    await expect(remove(env)).rejects.toThrow('BITRIX24_PAYMENT_NOT_OWNED');
    expect(env.payments.has('700')).toBe(true);
    expect(env.calls.some((call) => call.startsWith('delete:') || call.includes(':N:'))).toBe(false);
    expect(env.operations.size).toBe(0);
  });

  it('deletes our unpaid payment without an operation; a missing one is a success', async () => {
    const env = setup({ remote: { 700: ours('N', 5000) } });
    await remove(env);
    expect(env.payments.has('700')).toBe(false);
    expect(env.operations.size).toBe(0);
    await remove(env);
    expect(env.calls.filter((call) => call.startsWith('delete:'))).toEqual(['delete:700']);
  });

  it('a paid payment while the flag is off keeps Bitrix24 refusal', async () => {
    const env = setup({ remote: { 700: ours('Y', 5000) }, policy: { enabled: false } });
    await expect(remove(env)).rejects.toThrow('SALE_PAYMENT_DELETE_EXIST_PAID');
    expect(env.operations.size).toBe(0);
  });
});

describe('Bitrix24PaidPaymentGuard — start policy', () => {
  it('starts operations only for allow-listed orders while recovery is never limited (15)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) }, policy: { orderIds: new Set(['11548']) } });
    await expect(update(env)).rejects.toThrow('Нельзя изменить сумму');
    expect(env.operations.size).toBe(0);

    env.policy.orderIds = new Set(['2']);
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    env.policy.orderIds = new Set(['11548']);
    env.policy.enabled = false;
    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
  });

  it('recovery proves writer ownership before Bitrix calls', async () => {
    const env = setup({ remote: { 700: ours('Y', 142000) } });
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow();
    await expect(env.guard.recoverDue(async () => { throw new Error('ownership lost'); })).rejects.toThrow('ownership lost');
    expect(env.payments.get('700')!.paid).toBe('N');
  });
});

/** Payment cards («Поступила оплата от клиента») as the production portal holds them (17.10). */
function withCards(
  env: ReturnType<typeof setup>,
  cards: Array<{ id: string; completed: boolean; sum: number | null }>,
  failClose?: Error,
) {
  const bitrix = env.bitrix as Bitrix24ApiPort & Record<string, unknown>;
  const closed: string[] = [];
  const control: { failList?: Error; failClose?: Error } = {};
  bitrix.listPaymentCards = async (paymentId: string) => {
    env.calls.push(`cards:${paymentId}`);
    if (control.failList) throw control.failList;
    return cards.map((card) => ({ ...card }));
  };
  bitrix.completeActivity = async (id: string) => {
    env.calls.push(`close:${id}`);
    if (control.failClose) throw control.failClose;
    if (failClose) throw failClose;
    closed.push(id);
    const card = cards.find((item) => item.id === id);
    if (card) card.completed = true;
  };
  return { cards, closed, control };
}

describe('Bitrix24PaidPaymentGuard — payment card with the old amount', () => {
  it('closes the open card that still shows the old amount, audited before and after, then completes', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    const cards = withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
    await expect(update(env)).resolves.toBe('applied');
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect(cards.closed).toEqual(['8015']);
    expect(env.calls.slice(-3)).toEqual(['update:700:Y:300', 'cards:700', 'close:8015']);
    expect(env.audits).toEqual([
      'requested:3', 'unpaid:3', 'card_requested:3:8015:68445→300', 'card_closed:3:8015:68445→300', 'completed:3:applied',
    ]);
  });

  it('closes every open card, also one with the current amount or without an amount; leaves closed cards', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    const cards = withCards(env, [
      { id: '1', completed: true, sum: 68445 },
      { id: '2', completed: false, sum: 300 },
      { id: '3', completed: false, sum: null },
    ]);
    await update(env);
    expect(cards.closed).toEqual(['2', '3']);
    expect(env.audits).toEqual([
      'requested:3', 'unpaid:3', 'card_requested:3:2,3:300,→300', 'card_closed:3:2,3:300,→300', 'completed:3:applied',
    ]);
  });

  it('closes the card Bitrix24 reopens when the amount returns to the old one (production 18.10, order 1258тест)', async () => {
    const env = setup({ remote: { 700: ours('Y', 142717) }, erpPayments: [payment({ amount: 142716 })] });
    const cards = withCards(env, [{ id: '7942', completed: false, sum: 142717 }]);
    // The portal keeps one card per payment and reopens it whenever the payment is marked paid again.
    const bitrix = env.bitrix as Bitrix24ApiPort & Record<string, unknown>;
    const updatePayment = bitrix.updatePayment as (id: string, fields: Record<string, unknown>) => Promise<void>;
    bitrix.updatePayment = async (id: string, fields: Record<string, unknown>) => {
      const wasPaid = env.payments.get(id)?.paid;
      await updatePayment(id, fields);
      if (wasPaid === 'N' && fields.paid === 'Y') for (const card of cards.cards) card.completed = false;
    };

    await expect(update(env, payment({ amount: 142716 }))).resolves.toBe('applied');
    expect(cards.closed).toEqual(['7942']);

    env.erp.set('3', payment({ amount: 142717 }));
    await expect(update(env, payment({ amount: 142717 }))).resolves.toBe('applied');
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 142717 });
    expect(cards.closed).toEqual(['7942', '7942']);
    expect(cards.cards[0].completed).toBe(true);
    expect(env.audits.filter((audit) => audit.startsWith('card_'))).toEqual([
      'card_requested:3:7942:142717→142716', 'card_closed:3:7942:142717→142716',
      'card_requested:3:7942:142717→142717', 'card_closed:3:7942:142717→142717',
    ]);
  });

  it('audits a refused close and still completes the applied payment', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    withCards(env, [{ id: '8015', completed: false, sum: 68445 }],
      new Bitrix24ApiError('crm.activity.update', 'ACCESS_DENIED', 403, 'Access denied'));
    await expect(update(env)).resolves.toBe('applied');
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect(env.audits.slice(-3)).toEqual([
      'card_requested:3:8015:68445→300',
      'card_failed:3::68445→300:Bitrix24 crm.activity.update failed: 403 ACCESS_DENIED Access denied',
      'completed:3:applied',
    ]);
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', attempts: 0 });
  });

  it('touches no card when the update needed no paid reset or the payment was deleted', async () => {
    const plain = setup({ remote: { 700: ours('N', 142000) } });
    withCards(plain, [{ id: '8015', completed: false, sum: 142000 }]);
    await update(plain);
    expect(plain.calls.filter((call) => call.startsWith('cards:'))).toEqual([]);

    const removed = setup({ remote: { 700: ours('Y', 68445) } });
    withCards(removed, [{ id: '8015', completed: false, sum: 68445 }]);
    await remove(removed);
    expect(removed.calls.filter((call) => call.startsWith('cards:') || call.startsWith('close:'))).toEqual([]);
  });

  it('keeps the operation open when the close audit cannot be written; recovery records it and completes', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    const cards = withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
    env.store.failCardAudit = 'closed';
    await expect(update(env)).rejects.toThrow('audit failure closed');
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'unpaid', attempts: 1 });
    expect(cards.closed).toEqual(['8015']);

    // The card was closed before the failed write: recovery no longer lists it as open; nothing is closed twice.
    env.store.failCardAudit = undefined;
    await expect(env.guard.recoverDue(async () => undefined)).resolves.toEqual({ completed: 1, failed: 0 });
    expect(cards.closed).toEqual(['8015']);
    expect([...env.operations.values()][0]).toMatchObject({ phase: 'completed', outcome: 'applied' });
  });

  it('retries the close when the requested audit cannot be written (Bitrix24 untouched)', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    const cards = withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
    env.store.failCardAudit = 'requested';
    await expect(update(env)).rejects.toThrow('audit failure requested');
    expect(cards.closed).toEqual([]);
    env.store.failCardAudit = undefined;
    await env.guard.recoverDue(async () => undefined);
    expect(cards.closed).toEqual(['8015']);
    expect(env.audits.filter((audit) => audit.startsWith('card_'))).toEqual([
      'card_requested:3:8015:68445→300', 'card_closed:3:8015:68445→300',
    ]);
  });

  it.each(['list', 'close'] as const)(
    'keeps the operation open when writer ownership is lost before the card %s; a fresh owner finishes it',
    async (at) => {
      const env = setup({ remote: { 700: ours('Y', 68445) } });
      const cards = withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
      const lost = Object.assign(new Error('CRM sync relay lost live-writer ownership'), { name: 'OwnershipLost' });
      if (at === 'list') cards.control.failList = lost; else cards.control.failClose = lost;
      await expect(update(env)).rejects.toThrow('lost live-writer ownership');
      expect([...env.operations.values()][0]).toMatchObject({ phase: 'unpaid', attempts: 1 });
      expect(env.audits.filter((audit) => audit.startsWith('completed:') || audit.startsWith('card_failed'))).toEqual([]);
      expect(env.domainEvents).toEqual([]);

      cards.control.failList = undefined;
      cards.control.failClose = undefined;
      await expect(env.guard.recoverDue(async () => undefined)).resolves.toEqual({ completed: 1, failed: 0 });
      expect(cards.closed).toEqual(['8015']);
      expect(env.audits.at(-1)).toBe('completed:3:applied');
    },
  );

  it('closes no card once the flag is off or the order is outside the allowlist, also for a started operation', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    const cards = withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow('fetch failed');
    env.policy.enabled = false;
    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 300 });
    expect(cards.closed).toEqual([]);
    expect(env.calls.filter((call) => call.startsWith('cards:'))).toEqual([]);

    const other = setup({ remote: { 700: ours('Y', 68445) }, policy: { orderIds: new Set(['2']) } });
    const otherCards = withCards(other, [{ id: '8015', completed: false, sum: 68445 }]);
    other.failures.push({ match: (call) => call === 'update:700:Y:300' && other.payments.get('700')!.paid === 'N' });
    await expect(update(other)).rejects.toThrow('fetch failed');
    other.policy.orderIds = new Set(['99']);
    await other.guard.recoverDue(async () => undefined);
    expect(otherCards.closed).toEqual([]);
  });

  it('records the amount actually applied when ERP changed again before recovery', async () => {
    const env = setup({ remote: { 700: ours('Y', 68445) } });
    withCards(env, [{ id: '8015', completed: false, sum: 68445 }]);
    env.failures.push({ match: (call) => call === 'update:700:Y:300' && env.payments.get('700')!.paid === 'N' });
    await expect(update(env)).rejects.toThrow('fetch failed');
    env.erp.set('3', payment({ amount: 450 }));
    await env.guard.recoverDue(async () => undefined);
    expect(env.payments.get('700')).toMatchObject({ paid: 'Y', sum: 450 });
    expect(env.audits.filter((audit) => audit.startsWith('card_'))).toEqual([
      'card_requested:3:8015:68445→450', 'card_closed:3:8015:68445→450',
    ]);
  });
});
