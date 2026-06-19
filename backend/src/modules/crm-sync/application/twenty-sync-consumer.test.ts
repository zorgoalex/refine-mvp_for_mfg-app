import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrmSourcePort, ClientRow, OrderRow, MappingRow } from './crm-sync.types';
import type { TwentyApiPort } from '../adapters/twenty-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { DatabaseService } from '../../../database/database.service';
import { TwentySyncConsumer } from './twenty-sync-consumer';
import { mapClient, mapOrder, hash } from './twenty-sync-mapper';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CLIENT_ROW: ClientRow = {
  clientId: 'c-1',
  clientName: 'Acme Corp',
  notes: null,
  isActive: true,
};

const ORDER_ROW: OrderRow = {
  orderId: 'o-1',
  orderNumber: 'ORD-1',
  orderName: 'Order One',
  clientId: 'c-1',
  totalAmount: 500,
  finalAmount: 400,
  paidAmount: 200,
  orderStatusName: 'В работе',
  paymentStatusName: null,
  orderDate: '2026-01-01',
  completionDate: null,
  deleteFlag: false,
};

function makeEvent(
  entity: 'client' | 'order',
  id: string,
  op: 'upsert' | 'delete',
): OutboxEventRecord {
  return {
    outboxEventId: `evt-${entity}-${id}-${op}`,
    eventType: 'crm.sync.entity',
    aggregateType: entity,
    aggregateId: id,
    payload: { entity, id, op },
    attempts: 0,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
function makeSource(overrides?: Partial<CrmSourcePort>): CrmSourcePort {
  return {
    getClientById: vi.fn().mockResolvedValue(CLIENT_ROW),
    getOrderById: vi.fn().mockResolvedValue(ORDER_ROW),
    listClientIds: vi.fn().mockResolvedValue([]),
    listOrderIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as CrmSourcePort;
}

function makeTwenty(overrides?: Partial<TwentyApiPort>): TwentyApiPort {
  return {
    createRecord: vi.fn().mockResolvedValue({ id: 'twenty-new-id' }),
    updateRecord: vi.fn().mockResolvedValue(undefined),
    findIdByErpId: vi.fn().mockResolvedValue(null),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TwentyApiPort;
}

function makeMapping(get: (entityType: string, erpId: string) => MappingRow | null): PgCrmSyncMappingRepository {
  return {
    get: vi.fn().mockImplementation((_db: unknown, entityType: string, erpId: string) =>
      Promise.resolve(get(entityType, erpId)),
    ),
    upsertSuccess: vi.fn(),
    markFailed: vi.fn(),
  } as unknown as PgCrmSyncMappingRepository;
}

const MOCK_DB = {} as DatabaseService;

// ---------------------------------------------------------------------------
// Test 1: client upsert, no mapping → returns [clientIntent] with twentyId from create
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client upsert, no mapping', () => {
  it('returns [clientIntent] with twentyId from create when no mapping exists', async () => {
    const source = makeSource();
    const twenty = makeTwenty(); // createRecord returns 'twenty-new-id'
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', 'c-1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    const intent = intents[0];
    expect(intent.mapping.entityType).toBe('client');
    expect(intent.mapping.erpId).toBe('c-1');
    expect(intent.mapping.twentyObject).toBe('companies');
    expect(intent.mapping.twentyId).toBe('twenty-new-id');
    expect(intent.mapping.status).toBe('active');
    expect(intent.mapping.lastHash).toBe(hash(mapClient(CLIENT_ROW)));
    // create was called (no existing mapping)
    expect(twenty.createRecord).toHaveBeenCalledWith('companies', mapClient(CLIENT_ROW));
    // update was NOT called
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: client upsert, existing mapping with twentyId, changed hash → updateRecord (PATCH)
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client upsert, existing mapping, changed hash', () => {
  it('calls updateRecord (PATCH) and returns [clientIntent] with updated hash', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const existingMapping: MappingRow = {
      entityType: 'client',
      erpId: 'c-1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: 'old-hash-value', // different from current hash
    };
    const mapping = makeMapping(() => existingMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', 'c-1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.twentyId).toBe('existing-twenty-id');
    expect(intents[0].mapping.status).toBe('active');
    // PATCH called, not create
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', 'existing-twenty-id', mapClient(CLIENT_ROW));
    expect(twenty.createRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3: client op delete, mapped → returns [softDeleteIntent] that PATCHed erpStatus=deleted
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client delete, mapped', () => {
  it('returns [softDeleteIntent] with status deleted and calls updateRecord with erpStatus=deleted', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const existingMapping: MappingRow = {
      entityType: 'client',
      erpId: 'c-1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: 'some-hash',
    };
    const mapping = makeMapping(() => existingMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', 'c-1', 'delete');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBe('existing-twenty-id');
    expect(intents[0].audit.event).toBe('crm_sync.softdelete');
    // PATCH with erpStatus=deleted
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', 'existing-twenty-id', { erpStatus: 'deleted' });
  });
});

// ---------------------------------------------------------------------------
// Test 4: no-op — mapping has twentyId, status active, lastHash === current hash → returns []
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — no-op (hash unchanged)', () => {
  it('returns [] when mapping is active and lastHash matches current hash', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const currentHash = hash(mapClient(CLIENT_ROW));
    const noopMapping: MappingRow = {
      entityType: 'client',
      erpId: 'c-1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: currentHash,
    };
    const mapping = makeMapping(() => noopMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', 'c-1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(0);
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 5: order upsert with UNSYNCED client → returns [clientIntent, orderIntent] in that order;
//         Company created BEFORE ErpOrder
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order upsert, client unsynced', () => {
  it('returns [clientIntent, orderIntent] in order; Company created before ErpOrder', async () => {
    const source = makeSource();
    const callOrder: string[] = [];
    const twenty = makeTwenty({
      createRecord: vi.fn().mockImplementation((object: string) => {
        callOrder.push(`create:${object}`);
        return Promise.resolve({ id: `new-${object}-id` });
      }),
    });
    // No mapping for either client or order
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', 'o-1', 'upsert');
    const intents = await consumer.sync(event);

    // [clientIntent, orderIntent]
    expect(intents).toHaveLength(2);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[1].mapping.entityType).toBe('order');

    // Company created BEFORE ErpOrder
    expect(callOrder[0]).toBe('create:companies');
    expect(callOrder[1]).toBe('create:erpOrders');
  });
});

// ---------------------------------------------------------------------------
// Test 6: order upsert where client mapping exists but twentyId=null (prior failure)
//         → re-runs client sync; recovers via findIdByErpId (no second company create);
//         returns both intents
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order upsert, client mapping exists but twentyId=null', () => {
  it('recovers via findIdByErpId; no second company create; returns both intents', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      createRecord: vi.fn().mockResolvedValue({ id: 'brand-new-id' }),
      findIdByErpId: vi.fn().mockImplementation((object: string) => {
        if (object === 'companies') return Promise.resolve('recovered-company-id');
        return Promise.resolve(null);
      }),
    });

    // Client mapping exists but twentyId=null (prior failure)
    const failedClientMapping: MappingRow = {
      entityType: 'client',
      erpId: 'c-1',
      twentyObject: 'companies',
      twentyId: null,
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'client') return failedClientMapping;
      return null; // no order mapping
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', 'o-1', 'upsert');
    const intents = await consumer.sync(event);

    // Both intents returned
    expect(intents).toHaveLength(2);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[0].mapping.twentyId).toBe('recovered-company-id');
    expect(intents[1].mapping.entityType).toBe('order');

    // findIdByErpId was called for companies (recovery)
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('companies', 'c-1');
    // No second create for companies (findIdByErpId returned a value)
    expect(twenty.createRecord).not.toHaveBeenCalledWith('companies', expect.anything());
    // updateRecord called for the recovered company
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', 'recovered-company-id', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Test 7: order upsert where the ORDER's own mapping is failed/twentyId=null
//         → recovers via findIdByErpId; no second erpOrders create
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order mapping failed/twentyId=null', () => {
  it('recovers order via findIdByErpId; no second erpOrders create', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      createRecord: vi.fn().mockResolvedValue({ id: 'new-id' }),
      findIdByErpId: vi.fn().mockImplementation((object: string) => {
        if (object === 'erpOrders') return Promise.resolve('recovered-order-id');
        return Promise.resolve(null); // no company in Twenty
      }),
    });

    // Client mapping exists and is synced
    const syncedClientMapping: MappingRow = {
      entityType: 'client',
      erpId: 'c-1',
      twentyObject: 'companies',
      twentyId: 'company-uuid',
      status: 'active',
      lastHash: 'some-hash',
    };
    // Order mapping exists but twentyId=null (prior failure)
    const failedOrderMapping: MappingRow = {
      entityType: 'order',
      erpId: 'o-1',
      twentyObject: 'erpOrders',
      twentyId: null,
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'client') return syncedClientMapping;
      if (entityType === 'order') return failedOrderMapping;
      return null;
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', 'o-1', 'upsert');
    const intents = await consumer.sync(event);

    // Only orderIntent (client already synced → no clientIntent pushed)
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('order');
    expect(intents[0].mapping.twentyId).toBe('recovered-order-id');

    // findIdByErpId was called for erpOrders (recovery)
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('erpOrders', 'o-1');
    // No create for erpOrders (findIdByErpId returned a value)
    expect(twenty.createRecord).not.toHaveBeenCalledWith('erpOrders', expect.anything());
    // updateRecord called for the recovered order
    expect(twenty.updateRecord).toHaveBeenCalledWith('erpOrders', 'recovered-order-id', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Test 8: audit.requestId === event.outboxEventId
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — audit.requestId matches outboxEventId', () => {
  it('audit.requestId equals event.outboxEventId on emitted intents', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', 'c-1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].audit.requestId).toBe(event.outboxEventId);
  });
});

// ---------------------------------------------------------------------------
// supports()
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.supports', () => {
  it('returns true for crm.sync.* events', () => {
    const consumer = new TwentySyncConsumer({
      source: makeSource(),
      twenty: makeTwenty(),
      mapping: makeMapping(() => null),
      db: MOCK_DB,
    });
    expect(consumer.supports('crm.sync.entity')).toBe(true);
    expect(consumer.supports('crm.sync.')).toBe(true);
    expect(consumer.supports('crm.sync.client.upsert')).toBe(true);
  });

  it('returns false for non-crm.sync events', () => {
    const consumer = new TwentySyncConsumer({
      source: makeSource(),
      twenty: makeTwenty(),
      mapping: makeMapping(() => null),
      db: MOCK_DB,
    });
    expect(consumer.supports('payment.created')).toBe(false);
    expect(consumer.supports('crm.other')).toBe(false);
    expect(consumer.supports('')).toBe(false);
  });
});
