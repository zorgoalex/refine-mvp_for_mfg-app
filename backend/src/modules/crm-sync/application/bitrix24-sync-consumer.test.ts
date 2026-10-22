import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import {
  Bitrix24ApiError,
  type Bitrix24ApiPort,
} from '../adapters/bitrix24-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import {
  Bitrix24SyncConsumer,
  CrmSyncTargetError,
} from './bitrix24-sync-consumer';
import { Bitrix24PaidPaymentGuard, type PaidPaymentOperationStore } from './bitrix24-paid-payment-guard';
import type { PaidPaymentOperation } from '../adapters/pg-crm-sync-paid-payment-operation-repository';
import type {
  ClientRow,
  CrmSourcePort,
  MappingRow,
  OrderRow,
  PaymentCreateGuardRow,
  PaymentRow,
} from './crm-sync.types';

const options = {
  erpBaseUrl: 'https://erp.example',
  currencyId: 'KZT',
  assignedById: 1,
  paySystemId: 6,
};

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    clientId: '1',
    clientName: 'Иван',
    personType: 'individual',
    notes: null,
    isActive: true,
    phones: [],
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderId: '2',
    orderNumber: '2',
    orderName: '24001',
    clientId: '1',
    totalAmount: 100,
    finalAmount: 90,
    paidAmount: 50,
    orderStatusName: 'Новый',
    paymentStatusName: 'Частично',
    orderDate: '2026-07-20',
    completionDate: null,
    deleteFlag: false,
    ...overrides,
  };
}

function makePayment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    paymentId: '3',
    orderId: '2',
    typePaidId: '1',
    typePaidName: 'Наличные',
    amount: 50,
    paymentDate: '2026-07-20',
    notes: null,
    ...overrides,
  };
}

function event(entity: 'client' | 'order', id: string, op: 'upsert' | 'delete'): OutboxEventRecord {
  return {
    outboxEventId: 'event-1',
    eventType: `crm.sync.${entity}.${op}`,
    aggregateType: 'crm_sync',
    aggregateId: id,
    payload: { entity, id, op, clientId: entity === 'order' ? '1' : null },
    attempts: 0,
  };
}

function harness(input?: {
  client?: ClientRow | null;
  order?: OrderRow | null;
  payments?: PaymentRow[];
  mappings?: MappingRow[];
  guards?: PaymentCreateGuardRow[];
  hasOrders?: boolean;
  paidPayments?: Bitrix24PaidPaymentGuard;
  /** Entities whose `assignedById` the assignment channel owns. */
  owned?: string[];
}) {
  const mappings = input?.mappings ?? [];
  const guards = new Map(
    (input?.guards ?? []).map((guard) => [guard.erpPaymentId, guard]),
  );
  const source: CrmSourcePort = {
    getClientById: vi.fn().mockResolvedValue(input?.client === undefined ? makeClient() : input.client),
    getOrderById: vi.fn().mockResolvedValue(input?.order === undefined ? makeOrder() : input.order),
    getPaymentsByOrderId: vi.fn().mockResolvedValue(input?.payments ?? []),
    hasOrdersForClient: vi.fn().mockResolvedValue(input?.hasOrders ?? false),
    listClientIds: vi.fn().mockResolvedValue([]),
    listOrderIds: vi.fn().mockResolvedValue([]),
  };
  let nextId = 100;
  const calls: string[] = [];
  const bitrix: Bitrix24ApiPort = {
    withRequestGuard: (_guard, operation) => operation(),
    createCrmItem: vi.fn(async (type) => {
      calls.push(`create:${type}`);
      return String(nextId++);
    }),
    updateCrmItem: vi.fn(async (type, id) => { calls.push(`update:${type}:${id}`); }),
    findCrmItemByOrigin: vi.fn().mockResolvedValue(null),
    deleteCrmItem: vi.fn(async (type, id) => { calls.push(`delete:${type}:${id}`); }),
    setDealProductRows: vi.fn(async (id) => { calls.push(`product:${id}`); }),
    findPaymentByXmlId: vi.fn().mockResolvedValue(null),
    listDealPaymentIds: vi.fn().mockResolvedValue([]),
    createDealPayment: vi.fn(async (id) => {
      calls.push(`payment-create:${id}`);
      return String(nextId++);
    }),
    updatePayment: vi.fn(async (id) => { calls.push(`payment-update:${id}`); }),
    deletePayment: vi.fn(async (id) => { calls.push(`payment-delete:${id}`); }),
  };
  const mapping = {
    get: vi.fn(async (_db, type: string, id: string) =>
      mappings.find((row) => row.entityType === type && row.erpId === id) ?? null),
    listByParent: vi.fn(async (_db, type: string, parent: string) =>
      mappings.filter((row) => row.entityType === type && row.parentErpId === parent)),
    getPaymentCreateGuard: vi.fn(async (_db, paymentId: string) =>
      guards.get(paymentId) ?? null),
    listPaymentCreateGuardsByOrder: vi.fn(async (_db, orderId: string) =>
      [...guards.values()].filter((guard) => guard.erpOrderId === orderId)),
    insertPaymentCreateGuard: vi.fn(async (_db, guard: PaymentCreateGuardRow) => {
      if (guards.has(guard.erpPaymentId)) return false;
      guards.set(guard.erpPaymentId, guard);
      return true;
    }),
    deletePaymentCreateGuard: vi.fn(async (_db, paymentId: string) => {
      guards.delete(paymentId);
    }),
    prepareOutboundOperation: vi.fn().mockResolvedValue(
      '00000000-0000-4000-8000-000000000001',
    ),
    completeOutboundOperation: vi.fn().mockResolvedValue(undefined),
    upsertSuccess: vi.fn().mockResolvedValue(true),
  } as unknown as PgCrmSyncMappingRepository;
  const db = {
    transaction: vi.fn(async (handler) => handler({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
  } as unknown as DatabaseService;
  const consumer = new Bitrix24SyncConsumer({
    source,
    bitrix,
    mapping,
    db,
    options,
    durablePaymentCreates: true,
    paidPayments: input?.paidPayments,
    assignment: input?.owned
      ? { ownsAssignment: vi.fn(async (entityType: string, erpId: string) => input.owned!.includes(`${entityType}:${erpId}`)) }
      : undefined,
  });
  return { consumer, source, bitrix, calls, guards, mapping };
}

describe('Bitrix24SyncConsumer', () => {
  it('creates Contact for an individual', async () => {
    const h = harness();
    const intents = await h.consumer.sync(event('client', '1', 'upsert'));
    expect(h.bitrix.createCrmItem).toHaveBeenCalledWith(3, expect.objectContaining({ name: 'Иван' }));
    expect(intents[0]?.mapping).toMatchObject({
      entityType: 'client',
      bitrixObject: 'contact',
      bitrixId: '100',
    });
  });

  it('replaces Contact with Company when person type changes', async () => {
    const old: MappingRow = {
      entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '8',
      parentErpId: null, status: 'active', lastHash: 'old',
    };
    const h = harness({ client: makeClient({ personType: 'legal' }), mappings: [old] });
    const intents = await h.consumer.sync(event('client', '1', 'upsert'));
    expect(h.calls).toEqual(['delete:3:8', 'create:4']);
    expect(intents[0]?.mapping.bitrixObject).toBe('company');
  });

  it('reasserts ERP client fields even when the local hash is unchanged', async () => {
    const first = harness();
    const [created] = await first.consumer.sync(event('client', '1', 'upsert'));
    const second = harness({ mappings: [created.mapping] });

    const intents = await second.consumer.sync(event('client', '1', 'upsert'));
    expect(second.calls).toEqual(['update:3:100']);
    expect(intents[0]?.mapping.bitrixId).toBe('100');
  });

  it('leaves assignedById to the assignment channel for the objects it owns', async () => {
    const owned = harness({ owned: ['client:1', 'order:2'] });
    await owned.consumer.sync(event('order', '2', 'upsert'));
    for (const call of owned.bitrix.createCrmItem.mock.calls) {
      expect(call[1]).not.toHaveProperty('assignedById');
    }
    const plain = harness({ owned: [] });
    await plain.consumer.sync(event('order', '2', 'upsert'));
    for (const call of plain.bitrix.createCrmItem.mock.calls) {
      expect(call[1]).toHaveProperty('assignedById', 1);
    }
  });

  it('updates a Bitrix-owned client without claiming ERP provenance', async () => {
    const h = harness({
      mappings: [{
        entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '10',
        parentErpId: null, status: 'active', lastHash: 'old', sourceSystem: 'bitrix24',
      }],
    });

    await h.consumer.sync(event('client', '1', 'upsert'));

    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(
      3,
      '10',
      expect.not.objectContaining({
        originatorId: expect.anything(),
        originId: expect.anything(),
        assignedById: expect.anything(),
      }),
    );
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalled();
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
  });

  it('creates counterparty, deal, one product row, and native payment', async () => {
    const h = harness({ payments: [makePayment()] });
    const intents = await h.consumer.sync(event('order', '2', 'upsert'));
    expect(h.calls).toEqual([
      'create:3',
      'create:2',
      'product:101',
      'payment-create:101',
      'payment-update:102',
    ]);
    expect(intents.map((intent) => intent.mapping.entityType)).toEqual([
      'client', 'order', 'payment',
    ]);
  });

  it('reasserts deal product rows and exact payment fields on replay', async () => {
    const first = harness({ payments: [makePayment()] });
    const firstIntents = await first.consumer.sync(event('order', '2', 'upsert'));
    const second = harness({
      payments: [makePayment()],
      mappings: firstIntents.map((intent) => intent.mapping),
    });
    vi.mocked(second.bitrix.listDealPaymentIds).mockResolvedValue(['102']);
    vi.mocked(second.bitrix.findPaymentByXmlId).mockResolvedValue('102');

    await second.consumer.sync(event('order', '2', 'upsert'));

    expect(second.bitrix.setDealProductRows).toHaveBeenCalledWith(
      '101',
      [expect.objectContaining({ price: 90, quantity: 1 })],
    );
    expect(second.bitrix.updatePayment).toHaveBeenCalledWith(
      '102',
      expect.objectContaining({ sum: 50, psSum: 50 }),
    );
  });

  it('acknowledges a CRM request without deleting its Bitrix Deal', async () => {
    const h = harness({
      order: makeOrder({ orderKind: 'crm_request', sourceSystem: 'bitrix24' }),
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'active', lastHash: 'old', sourceSystem: 'bitrix24',
      }],
    });

    await expect(h.consumer.sync(event('order', '2', 'upsert'))).resolves.toEqual([]);
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
    expect(h.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
  });

  it('updates only production-owned fields after converting a Bitrix Deal', async () => {
    const h = harness({
      order: makeOrder({ orderKind: 'production_order', sourceSystem: 'bitrix24' }),
      mappings: [
        {
          entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '10',
          parentErpId: null, status: 'active', lastHash: 'client-old', sourceSystem: 'erp',
        },
        {
          entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
          parentErpId: '1', status: 'active', lastHash: 'order-old', sourceSystem: 'bitrix24',
        },
      ],
    });

    await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(
      2,
      '20',
      expect.objectContaining({
        title: 'Заказ 24001',
        additionalInfo: 'https://erp.example/orders/show/2',
        begindate: '2026-07-20',
        contactId: 10,
      }),
    );
    const dealFields = vi.mocked(h.bitrix.updateCrmItem).mock.calls
      .find(([entityTypeId]) => entityTypeId === 2)?.[2];
    expect(dealFields).not.toHaveProperty('originatorId');
    expect(dealFields).not.toHaveProperty('originId');
    expect(dealFields).not.toHaveProperty('opportunity');
    expect(dealFields).not.toHaveProperty('currencyId');
    expect(dealFields).not.toHaveProperty('comments');
    expect(dealFields).not.toHaveProperty('assignedById');
    // Bitrix-owned orders keep CRM-originated product rows authoritative;
    // outbound sync must not overwrite them.
    expect(h.bitrix.setDealProductRows).not.toHaveBeenCalled();
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalled();
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
  });

  it('keeps the known Deal ID after a failed attempt instead of searching the portal', async () => {
    const h = harness({
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'failed', lastHash: 'old',
      }],
    });

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.calls).toContain('update:2:20');
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalledWith(2, expect.anything());
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalledWith(2, expect.anything());
    expect(intents.find((intent) => intent.mapping.entityType === 'order')?.mapping)
      .toMatchObject({ bitrixId: '20', status: 'active' });
  });

  it('falls back to the origin search when the Deal of a failed mapping is gone', async () => {
    const h = harness({
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'failed', lastHash: 'old',
      }],
    });
    vi.mocked(h.bitrix.updateCrmItem).mockImplementation(async (type, id) => {
      if (type === 2 && id === '20') {
        throw new Bitrix24ApiError('crm.item.update', 'ENTITY_NOT_FOUND', 404, 'not found');
      }
    });
    vi.mocked(h.bitrix.findCrmItemByOrigin).mockImplementation(async (type) => (type === 2 ? '21' : null));

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(2, '21', expect.anything());
    expect(intents.find((intent) => intent.mapping.entityType === 'order')?.mapping.bitrixId).toBe('21');
  });

  it('recovers a Bitrix-owned order whose last sync attempt failed', async () => {
    const h = harness({
      order: makeOrder({ orderKind: 'production_order', sourceSystem: 'bitrix24' }),
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'failed', lastHash: 'old', sourceSystem: 'bitrix24',
      }],
    });

    await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(2, '20', expect.anything());
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalledWith(2, expect.anything());
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalledWith(2, expect.anything());
  });

  it('still recreates the Deal of a mapping deleted by ERP (no failed reuse of deleted)', async () => {
    const h = harness({
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'deleted', lastHash: 'old',
      }],
    });

    await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.calls).not.toContain('update:2:20');
    expect(h.bitrix.findCrmItemByOrigin).toHaveBeenCalledWith(2, expect.anything());
  });

  it('does not recreate a remotely deleted Bitrix-owned Deal', async () => {
    const h = harness({
      order: makeOrder({ orderKind: 'production_order', sourceSystem: 'bitrix24' }),
      mappings: [{
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'remote_deleted', lastHash: 'old', sourceSystem: 'bitrix24',
      }],
    });

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      mapping: { status: 'remote_deleted', bitrixId: '20' },
      audit: {
        event: 'crm_sync.remote_deleted_skipped',
        metadata: { conflictCode: 'BITRIX24_DEAL_REMOTE_DELETED' },
      },
    });
    expect(h.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
  });

  it('deletes mapped payments before deleted deal', async () => {
    const mappings: MappingRow[] = [
      {
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'active', lastHash: 'x',
      },
      {
        entityType: 'payment', erpId: '3', bitrixObject: 'payment', bitrixId: '30',
        parentErpId: '2', status: 'active', lastHash: 'x',
      },
    ];
    const h = harness({ order: makeOrder({ deleteFlag: true }), mappings });
    const intents = await h.consumer.sync(event('order', '2', 'upsert'));
    expect(h.calls).toEqual(['payment-delete:30', 'delete:2:20']);
    expect(intents.every((intent) => intent.mapping.status === 'deleted')).toBe(true);
  });

  it('deletes both stale mapped IDs and deterministically discovered replacements', async () => {
    const mappings: MappingRow[] = [
      {
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'active', lastHash: 'x',
      },
      {
        entityType: 'payment', erpId: '3', bitrixObject: 'payment', bitrixId: '30',
        parentErpId: '2', status: 'active', lastHash: 'x',
      },
    ];
    const h = harness({ order: makeOrder({ deleteFlag: true }), mappings });
    vi.mocked(h.bitrix.findPaymentByXmlId).mockResolvedValue('31');
    vi.mocked(h.bitrix.findCrmItemByOrigin).mockResolvedValue('21');

    await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.deletePayment).toHaveBeenCalledWith('30');
    expect(h.bitrix.deletePayment).toHaveBeenCalledWith('31');
    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(2, '20');
    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(2, '21');
  });

  it('deletes a payment removed from ERP while keeping the deal', async () => {
    const mappings: MappingRow[] = [
      {
        entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '10',
        parentErpId: null, status: 'active', lastHash: 'client-old',
      },
      {
        entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
        parentErpId: '1', status: 'active', lastHash: 'order-old',
      },
      {
        entityType: 'payment', erpId: '3', bitrixObject: 'payment', bitrixId: '30',
        parentErpId: '2', status: 'active', lastHash: 'payment-old',
      },
    ];
    const h = harness({ mappings, payments: [] });

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.deletePayment).toHaveBeenCalledWith('30');
    expect(intents.find((intent) => intent.mapping.entityType === 'payment')?.mapping.status)
      .toBe('deleted');
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalledWith(2, '20');
  });

  it('attributes a mapped-payment delete failure to the payment', async () => {
    const h = harness({
      mappings: [{
        entityType: 'payment',
        erpId: '3',
        bitrixObject: 'payment',
        bitrixId: '30',
        parentErpId: '2',
        status: 'active',
        lastHash: 'old',
      }],
      payments: [],
    });
    vi.mocked(h.bitrix.deletePayment).mockRejectedValueOnce(new Error('delete failed'));

    const error = await h.consumer
      .sync(event('order', '2', 'upsert'))
      .catch((value) => value);

    expect(error).toBeInstanceOf(CrmSyncTargetError);
    expect(error.target).toMatchObject({
      entityType: 'payment',
      erpId: '3',
      relatedOrderId: 2,
      relatedPaymentId: 3,
    });
  });

  it('keeps the create guard if exact payment update fails', async () => {
    const h = harness({ payments: [makePayment()] });
    vi.mocked(h.bitrix.updatePayment).mockRejectedValueOnce(new Error('sale update failed'));

    await expect(h.consumer.sync(event('order', '2', 'upsert')))
      .rejects.toThrow('sale update failed');
    expect(h.bitrix.deletePayment).not.toHaveBeenCalledWith('102');
    expect(h.guards.get('3')).toMatchObject({
      erpOrderId: '2',
      bitrixDealId: '101',
      beforeIds: [],
    });
  });

  it('never retries an ambiguous payment create without recovering its guard', async () => {
    const h = harness({ payments: [makePayment()] });
    vi.mocked(h.bitrix.createDealPayment)
      .mockRejectedValueOnce(new Error('connection reset after request'));

    await expect(h.consumer.sync(event('order', '2', 'upsert')))
      .rejects.toThrow('connection reset after request');
    await expect(h.consumer.sync(event('order', '2', 'upsert')))
      .rejects.toThrow(/ambiguous Bitrix payment create/);

    expect(h.bitrix.createDealPayment).toHaveBeenCalledTimes(1);
    expect(h.guards.has('3')).toBe(true);
  });

  it('recovers the single guarded candidate and tags it without another create', async () => {
    const guard: PaymentCreateGuardRow = {
      erpPaymentId: '3',
      erpOrderId: '2',
      bitrixDealId: '101',
      beforeIds: ['9'],
    };
    const h = harness({ payments: [makePayment()], guards: [guard] });
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue(['102', '9']);

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.createDealPayment).not.toHaveBeenCalled();
    expect(h.bitrix.updatePayment).toHaveBeenCalledWith(
      '102',
      expect.objectContaining({ xmlId: 'MEBELKZ_ERP_PAYMENT_3' }),
    );
    expect(h.guards.has('3')).toBe(true);
    expect(intents.find((intent) => intent.mapping.entityType === 'payment'))
      .toMatchObject({ clearPaymentCreateGuardId: '3' });
  });

  it('keeps enough guard state to delete a payment after mapping persistence fails', async () => {
    const first = harness({ payments: [makePayment()] });
    await first.consumer.sync(event('order', '2', 'upsert'));
    const guard = first.guards.get('3');
    expect(guard).toBeDefined();

    const deletion = harness({
      order: makeOrder({ deleteFlag: true }),
      guards: [guard!],
    });
    vi.mocked(deletion.bitrix.listDealPaymentIds).mockResolvedValue(['102']);
    vi.mocked(deletion.bitrix.findCrmItemByOrigin).mockResolvedValue('101');

    const intents = await deletion.consumer.sync(event('order', '2', 'upsert'));

    expect(deletion.calls.indexOf('payment-delete:102'))
      .toBeLessThan(deletion.calls.indexOf('delete:2:101'));
    expect(intents.find((intent) => intent.mapping.entityType === 'payment'))
      .toMatchObject({ clearPaymentCreateGuardId: '3' });
  });

  it('deletes and recreates an XML-tagged payment attached to another Deal', async () => {
    const h = harness({
      payments: [makePayment()],
      mappings: [{
        entityType: 'payment',
        erpId: '3',
        bitrixObject: 'payment',
        bitrixId: '30',
        parentErpId: '9',
        status: 'active',
        lastHash: 'old',
      }],
    });
    vi.mocked(h.bitrix.findPaymentByXmlId).mockResolvedValue('30');
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue([]);

    const intents = await h.consumer.sync(event('order', '2', 'upsert'));

    expect(h.bitrix.deletePayment).toHaveBeenCalledWith('30');
    expect(h.bitrix.createDealPayment).toHaveBeenCalledWith('101');
    expect(intents.find((intent) => intent.mapping.entityType === 'payment')?.mapping)
      .toMatchObject({ parentErpId: '2', bitrixId: '102' });
  });

  it('recovers a stale mapped CRM ID through origin search', async () => {
    const mapping: MappingRow = {
      entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '8',
      parentErpId: null, status: 'active', lastHash: 'old',
    };
    const h = harness({ mappings: [mapping] });
    vi.mocked(h.bitrix.updateCrmItem)
      .mockRejectedValueOnce(new Bitrix24ApiError('crm.item.update', 'ENTITY_NOT_FOUND', 404, 'not found'))
      .mockResolvedValueOnce(undefined);
    vi.mocked(h.bitrix.findCrmItemByOrigin).mockResolvedValueOnce('9');

    const intents = await h.consumer.sync(event('client', '1', 'upsert'));

    expect(h.bitrix.findCrmItemByOrigin).toHaveBeenCalledWith(3, 'CLIENT_1');
    expect(h.bitrix.updateCrmItem).toHaveBeenLastCalledWith(
      3,
      '9',
      expect.objectContaining({ originId: 'CLIENT_1' }),
    );
    expect(intents[0]?.mapping.bitrixId).toBe('9');
  });

  it('keeps client while any ERP order references it', async () => {
    const h = harness({ client: null, hasOrders: true });
    await expect(h.consumer.sync(event('client', '1', 'delete'))).resolves.toEqual([]);
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
  });

  it('deletes both stale mapped and replacement counterparty IDs', async () => {
    const h = harness({
      client: null,
      mappings: [{
        entityType: 'client',
        erpId: '1',
        bitrixObject: 'contact',
        bitrixId: '8',
        parentErpId: null,
        status: 'active',
        lastHash: 'old',
      }],
    });
    vi.mocked(h.bitrix.findCrmItemByOrigin)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('9');

    await h.consumer.sync(event('client', '1', 'delete'));

    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(3, '8');
    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(4, '9');
  });

  it('fails an order projection when its ERP client is missing', async () => {
    const h = harness({ client: null });
    await expect(h.consumer.sync(event('order', '2', 'upsert')))
      .rejects.toThrow(/client 1 not found/);
    expect(h.calls).toEqual([]);
  });

  it('fails closed on malformed events', async () => {
    const h = harness();
    await expect(h.consumer.sync({
      ...event('client', '1', 'upsert'),
      payload: { entity: 'bogus', id: '1', op: 'upsert' },
    })).rejects.toThrow(/unknown entity/);
  });
});

describe('Bitrix24SyncConsumer — paid payments and stale deletes', () => {
  const paymentMapping = (erpId: string, bitrixId: string, sourceSystem: 'erp' | 'bitrix24' = 'erp'): MappingRow => ({
    entityType: 'payment', erpId, bitrixObject: 'payment', bitrixId, parentErpId: '2',
    status: 'active', lastHash: 'h', sourceSystem,
  });
  const orderMapping: MappingRow = {
    entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '50', parentErpId: '1',
    status: 'active', lastHash: 'h', sourceSystem: 'erp',
  };
  const guardMock = () => ({
    update: vi.fn().mockResolvedValue('applied'),
    delete: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined),
    settleOrder: vi.fn().mockResolvedValue(undefined),
  });

  it('finishes open operations of the order and the payment before reading mappings and guards', async () => {
    const paid = guardMock();
    const h = harness({
      payments: [makePayment()],
      mappings: [orderMapping, paymentMapping('3', '700')],
      paidPayments: paid as unknown as Bitrix24PaidPaymentGuard,
    });
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue(['700']);
    await h.consumer.sync(event('order', '2', 'upsert'));
    expect(paid.settleOrder).toHaveBeenCalledWith('2', ['3'], 'event-1');
    expect(paid.settle).toHaveBeenCalledWith('3', 'event-1');
    const settleOrderAt = paid.settleOrder.mock.invocationCallOrder[0];
    const settleAt = paid.settle.mock.invocationCallOrder[0];
    const paymentMappingReads = vi.mocked(h.mapping.get).mock.calls
      .map((call, index) => [call[1], vi.mocked(h.mapping.get).mock.invocationCallOrder[index]] as const)
      .filter(([type]) => type === 'payment');
    expect(paymentMappingReads.every(([, at]) => at > settleAt && at > settleOrderAt)).toBe(true);
  });

  it('settles a soft-deleted order before deleting its payments', async () => {
    const paid = guardMock();
    const h = harness({ order: makeOrder({ deleteFlag: true }), mappings: [orderMapping], paidPayments: paid as unknown as Bitrix24PaidPaymentGuard });
    await h.consumer.sync(event('order', '2', 'upsert'));
    expect(paid.settleOrder).toHaveBeenCalledWith('2', [], 'event-1');
  });

  it('never records a vanished Bitrix payment as synced', async () => {
    const paid = guardMock();
    paid.update.mockResolvedValue('remote_missing');
    const h = harness({
      payments: [makePayment()],
      mappings: [orderMapping, paymentMapping('3', '700')],
      paidPayments: paid as unknown as Bitrix24PaidPaymentGuard,
    });
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue(['700']);
    await expect(h.consumer.sync(event('order', '2', 'upsert'))).rejects.toThrow(/is gone \(remote_missing\)/);
  });

  it('routes payment updates through the paid-payment guard', async () => {
    const paid = guardMock();
    const h = harness({
      payments: [makePayment()],
      mappings: [orderMapping, paymentMapping('3', '700')],
      paidPayments: paid as unknown as Bitrix24PaidPaymentGuard,
    });
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue(['700']);
    await h.consumer.sync(event('order', '2', 'upsert'));
    expect(paid.update).toHaveBeenCalledWith(expect.objectContaining({
      bitrixId: '700', dealId: '50', requestId: 'event-1',
      payment: expect.objectContaining({ paymentId: '3' }),
      fields: expect.objectContaining({ sum: 50, paid: 'Y' }),
    }));
    expect(h.bitrix.updatePayment).not.toHaveBeenCalled();
  });

  it('routes payment deletes of a soft-deleted order through the guard and keeps Bitrix-owned payments (8)', async () => {
    const paid = guardMock();
    const h = harness({
      order: makeOrder({ deleteFlag: true }),
      mappings: [orderMapping, paymentMapping('3', '700'), paymentMapping('4', '701', 'bitrix24')],
      guards: [{ erpPaymentId: '5', erpOrderId: '2', bitrixDealId: '50', beforeIds: [] }],
      paidPayments: paid as unknown as Bitrix24PaidPaymentGuard,
    });
    vi.mocked(h.bitrix.listDealPaymentIds).mockResolvedValue(['702']);
    await h.consumer.sync(event('order', '2', 'upsert'));
    expect(paid.delete).toHaveBeenCalledWith(expect.objectContaining({ erpPaymentId: '5', bitrixId: '702', erpOrderId: '2' }));
    expect(paid.delete).toHaveBeenCalledWith(expect.objectContaining({ erpPaymentId: '3', bitrixId: '700', erpOrderId: '2' }));
    expect(paid.delete).not.toHaveBeenCalledWith(expect.objectContaining({ erpPaymentId: '4' }));
    expect(h.bitrix.deletePayment).not.toHaveBeenCalled();
    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(2, '50');
  });

  it('routes deletes of removed ERP payments of a live order through the guard', async () => {
    const paid = guardMock();
    const h = harness({
      payments: [],
      mappings: [orderMapping, paymentMapping('3', '700')],
      paidPayments: paid as unknown as Bitrix24PaidPaymentGuard,
    });
    await h.consumer.sync(event('order', '2', 'upsert'));
    expect(paid.delete).toHaveBeenCalledWith(expect.objectContaining({
      erpPaymentId: '3', erpOrderId: '2', dealId: '50', bitrixId: '700', requestId: 'event-1',
    }));
  });

  it('projects an order instead of deleting its Deal when a delete event meets a live order (14)', async () => {
    const h = harness({ mappings: [orderMapping] });
    const intents = await h.consumer.sync(event('order', '2', 'delete'));
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
    const order = intents.find((intent) => intent.mapping.entityType === 'order');
    expect(order?.mapping).toMatchObject({ status: 'active', bitrixId: '50' });
    expect(order?.extraAudits?.[0]).toMatchObject({
      event: 'crm_sync.stale_delete_projected', entityType: 'order', entityId: '2', relatedOrderId: 2,
    });
  });

  it('still deletes the Deal when the order is gone at execution', async () => {
    const h = harness({ order: null, mappings: [orderMapping] });
    await h.consumer.sync(event('order', '2', 'delete'));
    expect(h.bitrix.deleteCrmItem).toHaveBeenCalledWith(2, '50');
  });

  it('projects a client instead of deleting its Contact when the client exists (14)', async () => {
    const h = harness({
      mappings: [{ entityType: 'client', erpId: '1', bitrixObject: 'contact', bitrixId: '8', parentErpId: null, status: 'active', lastHash: 'old' }],
    });
    const intents = await h.consumer.sync(event('client', '1', 'delete'));
    expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
    expect(intents[0]?.extraAudits?.[0]).toMatchObject({ event: 'crm_sync.stale_delete_projected', entityType: 'client' });
  });
});

describe('Bitrix24SyncConsumer with the real paid-payment guard (backfill and relay share it)', () => {
  const openOperation: PaidPaymentOperation = {
    operationId: 'op-1', erpPaymentId: '3', erpOrderId: '2', bitrixPaymentId: '700', bitrixDealId: '50',
    action: 'update', phase: 'unpaid', attempts: 0, stuckAt: null,
    originOutboxEventId: null, bitrixSumBefore: 142000, targetSum: 50,
  };
  const store = (open: PaidPaymentOperation[]): PaidPaymentOperationStore => ({
    findOpen: vi.fn(async (id: string) => open.find((op) => op.erpPaymentId === id) ?? null),
    listOpenFor: vi.fn(async () => open),
    listDue: vi.fn(async () => open),
    begin: vi.fn(),
    markUnpaid: vi.fn(),
    switchToDelete: vi.fn(),
    complete: vi.fn(async () => true),
    recordFailure: vi.fn(async () => undefined),
  });
  const realGuard = (bitrix: Bitrix24ApiPort, operations: PaidPaymentOperation[]) => new Bitrix24PaidPaymentGuard({
    bitrix,
    store: store(operations),
    source: { getPaymentById: async () => makePayment() },
    options,
    // As in the backfill CLI: never starts a new operation.
    policy: () => ({ enabled: false, orderIds: new Set<string>() }),
  });

  it('cannot create a replacement payment while an open operation cannot be finished', async () => {
    const h = harness({ payments: [makePayment()], mappings: [{
      entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '50', parentErpId: '1',
      status: 'active', lastHash: 'h', sourceSystem: 'erp',
    }] });
    (h.bitrix as unknown as { getPayment: unknown }).getPayment = vi.fn().mockRejectedValue(new Error('Bitrix down'));
    const consumer = new Bitrix24SyncConsumer({
      source: h.source, bitrix: h.bitrix, mapping: h.mapping,
      db: { transaction: vi.fn(async (handler) => handler({ query: vi.fn().mockResolvedValue({ rows: [] }) })) } as unknown as DatabaseService,
      options, durablePaymentCreates: true,
      paidPayments: realGuard(h.bitrix, [openOperation]),
    });
    await expect(consumer.sync(event('order', '2', 'upsert'))).rejects.toThrow('Bitrix down');
    expect(h.bitrix.createDealPayment).not.toHaveBeenCalled();
    expect(h.mapping.insertPaymentCreateGuard).not.toHaveBeenCalled();
  });

  it('refuses to delete an untagged payment through the consumer', async () => {
    const h = harness({
      payments: [],
      mappings: [
        { entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '50', parentErpId: '1', status: 'active', lastHash: 'h', sourceSystem: 'erp' },
        { entityType: 'payment', erpId: '3', bitrixObject: 'payment', bitrixId: '700', parentErpId: '2', status: 'active', lastHash: 'h', sourceSystem: 'erp' },
      ],
    });
    (h.bitrix as unknown as { getPayment: unknown }).getPayment = vi.fn().mockResolvedValue({ paid: 'N', sum: 50, xmlId: null });
    const consumer = new Bitrix24SyncConsumer({
      source: h.source, bitrix: h.bitrix, mapping: h.mapping,
      db: { transaction: vi.fn(async (handler) => handler({ query: vi.fn().mockResolvedValue({ rows: [] }) })) } as unknown as DatabaseService,
      options, durablePaymentCreates: true,
      paidPayments: realGuard(h.bitrix, []),
    });
    await expect(consumer.sync(event('order', '2', 'upsert'))).rejects.toThrow('BITRIX24_PAYMENT_NOT_OWNED');
    expect(h.bitrix.deletePayment).not.toHaveBeenCalled();
  });
});
