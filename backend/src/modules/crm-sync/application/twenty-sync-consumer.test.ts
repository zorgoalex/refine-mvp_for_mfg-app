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
  clientId: '1',
  clientName: 'Acme Corp',
  notes: null,
  isActive: true,
};

const ORDER_ROW: OrderRow = {
  orderId: '2',
  orderNumber: 'ORD-1',
  orderName: 'Order One',
  clientId: '1',
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
  extra?: Record<string, unknown>,
): OutboxEventRecord {
  return {
    outboxEventId: `evt-${entity}-${id}-${op}`,
    eventType: 'crm.sync.entity',
    aggregateType: entity,
    aggregateId: id,
    payload: { entity, id, op, ...extra },
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
    const event = makeEvent('client', '1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    const intent = intents[0];
    expect(intent.mapping.entityType).toBe('client');
    expect(intent.mapping.erpId).toBe('1');
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
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: 'old-hash-value', // different from current hash
    };
    const mapping = makeMapping(() => existingMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
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
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: 'some-hash',
    };
    const mapping = makeMapping(() => existingMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'delete');
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
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'active',
      lastHash: currentHash,
    };
    const mapping = makeMapping(() => noopMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
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
    const event = makeEvent('order', '2', 'upsert');
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
      erpId: '1',
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
    const event = makeEvent('order', '2', 'upsert');
    const intents = await consumer.sync(event);

    // Both intents returned
    expect(intents).toHaveLength(2);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[0].mapping.twentyId).toBe('recovered-company-id');
    expect(intents[1].mapping.entityType).toBe('order');

    // findIdByErpId was called for companies (recovery)
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('companies', '1');
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
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'company-uuid',
      status: 'active',
      lastHash: 'some-hash',
    };
    // Order mapping exists but twentyId=null (prior failure)
    const failedOrderMapping: MappingRow = {
      entityType: 'order',
      erpId: '2',
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
    const event = makeEvent('order', '2', 'upsert');
    const intents = await consumer.sync(event);

    // Only orderIntent (client already synced → no clientIntent pushed)
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('order');
    expect(intents[0].mapping.twentyId).toBe('recovered-order-id');

    // findIdByErpId was called for erpOrders (recovery)
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('erpOrders', '2');
    // No create for erpOrders (findIdByErpId returned a value)
    expect(twenty.createRecord).not.toHaveBeenCalledWith('erpOrders', expect.anything());
    // updateRecord called for the recovered order
    expect(twenty.updateRecord).toHaveBeenCalledWith('erpOrders', 'recovered-order-id', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Test 8 (new): order upsert where CLIENT mapping status='failed' but twentyId is non-null
//   → ensureCompany falls through (non-active), re-syncs client via PATCH (known id),
//     pushes clientIntent (status='active'), NO second companies create, orderIntent follows
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order upsert, client mapping failed with non-null twentyId', () => {
  it('re-syncs client via PATCH, pushes clientIntent (active), no duplicate create', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      createRecord: vi.fn().mockResolvedValue({ id: 'should-not-be-called' }),
      updateRecord: vi.fn().mockResolvedValue(undefined),
      findIdByErpId: vi.fn().mockResolvedValue(null), // not needed — known id path used
    });

    // Client mapping: failed but twentyId is non-null (relay crashed before persisting 'active')
    const failedClientMappingWithId: MappingRow = {
      entityType: 'client',
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'cmp-1',
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'client') return failedClientMappingWithId;
      return null; // no order mapping
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', '2', 'upsert');
    const intents = await consumer.sync(event);

    // [clientIntent, orderIntent] — client must be re-synced first
    expect(intents).toHaveLength(2);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[1].mapping.entityType).toBe('order');

    // clientIntent must have status 'active' (mapping flipped)
    expect(intents[0].mapping.status).toBe('active');
    expect(intents[0].mapping.twentyId).toBe('cmp-1');

    // NO duplicate create for companies — known-id PATCH path used
    expect(twenty.createRecord).not.toHaveBeenCalledWith('companies', expect.anything());

    // updateRecord was called for companies with the known id (PATCH)
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', 'cmp-1', mapClient(CLIENT_ROW));
  });
});

// ---------------------------------------------------------------------------
// Test 9: audit.requestId === event.outboxEventId
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — audit.requestId matches outboxEventId', () => {
  it('audit.requestId equals event.outboxEventId on emitted intents', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].audit.requestId).toBe(event.outboxEventId);
  });
});

// ---------------------------------------------------------------------------
// Test 10: client upsert with isActive=false → mapping.status='deleted', erpStatus='deleted' in body
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client upsert, isActive=false (soft-deleted)', () => {
  it('returns intent with mapping.status=deleted and Twenty body erpStatus=deleted', async () => {
    const inactiveClient: ClientRow = { ...CLIENT_ROW, isActive: false };
    const source = makeSource({
      getClientById: vi.fn().mockResolvedValue(inactiveClient),
    });
    const twenty = makeTwenty(); // createRecord returns 'twenty-new-id'
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.status).toBe('deleted');
    // The body sent to Twenty must have erpStatus='deleted'
    expect(twenty.createRecord).toHaveBeenCalledWith(
      'companies',
      expect.objectContaining({ erpStatus: 'deleted' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 11: stable soft-deleted mapping (status='deleted', hash match) → no-op []
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — no-op for stable soft-deleted mapping', () => {
  it('returns [] when mapping status=deleted and lastHash matches current hash', async () => {
    const inactiveClient: ClientRow = { ...CLIENT_ROW, isActive: false };
    const source = makeSource({
      getClientById: vi.fn().mockResolvedValue(inactiveClient),
    });
    const twenty = makeTwenty();
    const currentHash = hash(mapClient(inactiveClient));
    const deletedMapping: MappingRow = {
      entityType: 'client',
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'existing-twenty-id',
      status: 'deleted',
      lastHash: currentHash,
    };
    const mapping = makeMapping(() => deletedMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(0);
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 12: order upsert with deleteFlag=true → mapping.status='deleted'
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order upsert, deleteFlag=true', () => {
  it('returns orderIntent with mapping.status=deleted', async () => {
    const deletedOrder: OrderRow = { ...ORDER_ROW, deleteFlag: true };
    const source = makeSource({
      getOrderById: vi.fn().mockResolvedValue(deletedOrder),
    });
    const twenty = makeTwenty();
    // Client mapping already active (so ensureCompany short-circuits)
    const syncedClientMapping: MappingRow = {
      entityType: 'client',
      erpId: '1',
      twentyObject: 'companies',
      twentyId: 'company-uuid',
      status: 'active',
      lastHash: 'some-hash',
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'client') return syncedClientMapping;
      return null; // no order mapping
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', '2', 'upsert');
    const intents = await consumer.sync(event);

    // Only orderIntent (client already synced)
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('order');
    expect(intents[0].mapping.status).toBe('deleted');
    // The body sent to Twenty must have erpStatus='deleted'
    expect(twenty.createRecord).toHaveBeenCalledWith(
      'erpOrders',
      expect.objectContaining({ erpStatus: 'deleted' }),
    );
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

// ---------------------------------------------------------------------------
// Test 13: client delete — mapping has NO twentyId but findIdByErpId returns an id
//          → soft-delete intent returned (NOT []), updateRecord('companies', foundId) called
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client delete, no mapping twentyId but findIdByErpId recovers', () => {
  it('returns soft-delete intent when mapping has no twentyId but findIdByErpId returns an id', async () => {
    const source = makeSource();
    const foundId = 'recovered-company-id';
    const twenty = makeTwenty({
      findIdByErpId: vi.fn().mockImplementation((object: string) => {
        if (object === 'companies') return Promise.resolve(foundId);
        return Promise.resolve(null);
      }),
    });
    // Mapping exists but twentyId is null (prior failure)
    const noIdMapping: MappingRow = {
      entityType: 'client',
      erpId: '1',
      twentyObject: 'companies',
      twentyId: null,
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping(() => noIdMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'delete');
    const intents = await consumer.sync(event);

    // Must NOT return [] — recovery succeeded
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBe(foundId);
    expect(intents[0].mapping.entityType).toBe('client');

    // findIdByErpId called for companies
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('companies', '1');
    // updateRecord called with the recovered id
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', foundId, { erpStatus: 'deleted' });
  });
});

// ---------------------------------------------------------------------------
// Test 14: order delete — mapping is null (no twentyId) but findIdByErpId returns an id
//          → soft-delete intent; updateRecord('erpOrders', foundId); audit.relatedClientId populated
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order delete, no mapping but findIdByErpId recovers', () => {
  it('returns soft-delete intent with relatedClientId from payload when findIdByErpId recovers', async () => {
    const source = makeSource();
    const foundOrderId = 'recovered-order-id';
    const twenty = makeTwenty({
      findIdByErpId: vi.fn().mockImplementation((object: string) => {
        if (object === 'erpOrders') return Promise.resolve(foundOrderId);
        return Promise.resolve(null);
      }),
    });
    const mapping = makeMapping(() => null); // no mapping at all

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    // payload includes clientId (as the trigger would set it)
    const event = makeEvent('order', '2', 'delete', { clientId: '42' });
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBe(foundOrderId);
    expect(intents[0].mapping.entityType).toBe('order');

    // findIdByErpId called for erpOrders
    expect(twenty.findIdByErpId).toHaveBeenCalledWith('erpOrders', '2');
    // updateRecord called with recovered id
    expect(twenty.updateRecord).toHaveBeenCalledWith('erpOrders', foundOrderId, { erpStatus: 'deleted' });

    // relatedClientId populated from payload.clientId (numeric dimension)
    expect(intents[0].audit.relatedClientId).toBe(42);
    // relatedOrderId is Number(erpId) → a real numeric audit dimension
    expect(intents[0].audit.relatedOrderId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 15: order delete (normal — mapping has twentyId) → audit.relatedClientId from payload
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order delete, mapping has twentyId, relatedClientId from payload', () => {
  it('sets audit.relatedClientId from payload.clientId on normal order soft-delete', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const existingMapping: MappingRow = {
      entityType: 'order',
      erpId: '2',
      twentyObject: 'erpOrders',
      twentyId: 'existing-order-twenty-id',
      status: 'active',
      lastHash: 'some-hash',
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'order') return existingMapping;
      return null;
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', '2', 'delete', { clientId: '99' });
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBe('existing-order-twenty-id');
    expect(intents[0].audit.event).toBe('crm_sync.softdelete');
    // relatedOrderId is Number(erpId) → a real numeric audit dimension
    expect(intents[0].audit.relatedOrderId).toBe(2);
    // relatedClientId comes from payload, not the row (row is gone on hard delete)
    expect(intents[0].audit.relatedClientId).toBe(99);
    expect(twenty.updateRecord).toHaveBeenCalledWith('erpOrders', 'existing-order-twenty-id', { erpStatus: 'deleted' });
  });
});

// ---------------------------------------------------------------------------
// Test 16: invalid payload — unknown entity / unknown op → sync() REJECTS (throws)
//          This proves the relay would mark the event retry/failed (visible),
//          NOT silently mark it processed.
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — invalid payload fails closed', () => {
  it('rejects when payload.entity is unknown', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    // Corrupt the payload entity after construction
    (event.payload as Record<string, unknown>).entity = 'bogus';

    await expect(consumer.sync(event)).rejects.toThrow(/unknown entity 'bogus'/);
    // No Twenty side effects on a rejected malformed event
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects when payload.op is unknown (valid entity)', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    (event.payload as Record<string, unknown>).op = 'archive';

    await expect(consumer.sync(event)).rejects.toThrow(/unknown op 'archive'/);
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects when payload.id is empty (structurally-malformed id)', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');
    (event.payload as Record<string, unknown>).id = '';

    await expect(consumer.sync(event)).rejects.toThrow(/invalid id ''/);
    // Must NOT silently resolve to [] (which the relay would mark processed → drop)
    expect(source.getClientById).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects when payload.id is non-numeric', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', '2', 'upsert');
    (event.payload as Record<string, unknown>).id = 'o-1';

    await expect(consumer.sync(event)).rejects.toThrow(/invalid id 'o-1'/);
    expect(source.getOrderById).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects an order event when payload.clientId is non-numeric', async () => {
    const source = makeSource();
    const twenty = makeTwenty();
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    // valid id, but clientId carried in the payload is garbled
    const event = makeEvent('order', '2', 'delete', { clientId: 'c-99' });

    await expect(consumer.sync(event)).rejects.toThrow(/invalid clientId 'c-99'/);
    expect(twenty.createRecord).not.toHaveBeenCalled();
    expect(twenty.updateRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 18 (new): client delete — mapping EXISTS (status='failed', twentyId=null)
//   AND findIdByErpId returns null → converge the mapping to 'deleted' WITHOUT any
//   Twenty call. One tombstone intent, audit crm_sync.softdelete, twentyId null.
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — client delete, mapping exists but no Twenty record', () => {
  it('tombstones the mapping (status=deleted, twentyId=null) with NO Twenty call', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      findIdByErpId: vi.fn().mockResolvedValue(null), // nothing in Twenty
    });
    // Mapping exists: a prior failed create left status='failed', twentyId=null
    const failedMapping: MappingRow = {
      entityType: 'client',
      erpId: '1',
      twentyObject: 'companies',
      twentyId: null,
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping(() => failedMapping);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'delete');
    const intents = await consumer.sync(event);

    // Converged to a single tombstone intent
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBeNull();
    expect(intents[0].audit.event).toBe('crm_sync.softdelete');
    expect(intents[0].audit.relatedClientId).toBe(1);
    expect(intents[0].audit.metadata).toEqual({ twentyId: null });

    // NO Twenty mutation calls
    expect(twenty.updateRecord).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 19 (new): order delete — mapping EXISTS (status='failed', twentyId=null)
//   AND findIdByErpId returns null → tombstone the mapping WITHOUT any Twenty call.
//   audit.relatedClientId comes from payload.clientId.
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — order delete, mapping exists but no Twenty record', () => {
  it('tombstones the mapping (status=deleted, twentyId=null) with NO Twenty call; relatedClientId from payload', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      findIdByErpId: vi.fn().mockResolvedValue(null), // nothing in Twenty
    });
    const failedMapping: MappingRow = {
      entityType: 'order',
      erpId: '2',
      twentyObject: 'erpOrders',
      twentyId: null,
      status: 'failed',
      lastHash: null,
    };
    const mapping = makeMapping((entityType) => {
      if (entityType === 'order') return failedMapping;
      return null;
    });

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('order', '2', 'delete', { clientId: '42' });
    const intents = await consumer.sync(event);

    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('order');
    expect(intents[0].mapping.status).toBe('deleted');
    expect(intents[0].mapping.twentyId).toBeNull();
    expect(intents[0].audit.event).toBe('crm_sync.softdelete');
    expect(intents[0].audit.relatedOrderId).toBe(2);
    expect(intents[0].audit.relatedClientId).toBe(42);
    expect(intents[0].audit.metadata).toEqual({ twentyId: null });

    // NO Twenty mutation calls
    expect(twenty.updateRecord).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 20 (new): client/order delete with NO mapping AND findIdByErpId null → [] (unchanged)
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — delete with no mapping and no Twenty record → []', () => {
  it('client delete: no mapping, findIdByErpId null → returns []', async () => {
    const source = makeSource();
    const twenty = makeTwenty({ findIdByErpId: vi.fn().mockResolvedValue(null) });
    const mapping = makeMapping(() => null); // no mapping

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const intents = await consumer.sync(makeEvent('client', '1', 'delete'));

    expect(intents).toHaveLength(0);
    expect(twenty.updateRecord).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
  });

  it('order delete: no mapping, findIdByErpId null → returns []', async () => {
    const source = makeSource();
    const twenty = makeTwenty({ findIdByErpId: vi.fn().mockResolvedValue(null) });
    const mapping = makeMapping(() => null); // no mapping

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const intents = await consumer.sync(makeEvent('order', '2', 'delete', { clientId: '42' }));

    expect(intents).toHaveLength(0);
    expect(twenty.updateRecord).not.toHaveBeenCalled();
    expect(twenty.createRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 17: concurrent first-create race — createRecord throws once (erpId unique
//          conflict). findIdByErpId returns null on the PRE-create call but an id
//          on the POST-conflict call → recover via updateRecord, resolve to intent.
//          Distinct from Test 6 (sequential re-run, found BEFORE create).
// ---------------------------------------------------------------------------
describe('TwentySyncConsumer.sync — concurrent first-create conflict recovers', () => {
  it('on create conflict, re-resolves via findIdByErpId and updates (no rethrow, no duplicate)', async () => {
    const source = makeSource();
    let findCalls = 0;
    const twenty = makeTwenty({
      // First create throws (uniqueness conflict from the racing winner)
      createRecord: vi.fn().mockRejectedValue(new Error('erpId unique conflict')),
      // PRE-create resolve → null; POST-conflict resolve → the winner's id
      findIdByErpId: vi.fn().mockImplementation(() => {
        findCalls += 1;
        return Promise.resolve(findCalls === 1 ? null : 'race-winner-id');
      }),
    });
    const mapping = makeMapping(() => null); // no mapping → create path

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');

    // Resolves (no rethrow) to a single intent pointing at the winner's id
    const intents = await consumer.sync(event);
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping.entityType).toBe('client');
    expect(intents[0].mapping.twentyId).toBe('race-winner-id');

    // create was attempted once, then conflict recovery kicked in
    expect(twenty.createRecord).toHaveBeenCalledTimes(1);
    // findIdByErpId called twice: once pre-create (null), once post-conflict (id)
    expect(twenty.findIdByErpId).toHaveBeenCalledTimes(2);
    // recovered via update with the found id
    expect(twenty.updateRecord).toHaveBeenCalledWith('companies', 'race-winner-id', mapClient(CLIENT_ROW));
  });

  it('rethrows when create fails and post-conflict resolve still finds nothing (genuine failure)', async () => {
    const source = makeSource();
    const twenty = makeTwenty({
      createRecord: vi.fn().mockRejectedValue(new Error('boom — real failure')),
      findIdByErpId: vi.fn().mockResolvedValue(null), // never resolves to an id
    });
    const mapping = makeMapping(() => null);

    const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: MOCK_DB });
    const event = makeEvent('client', '1', 'upsert');

    await expect(consumer.sync(event)).rejects.toThrow(/boom — real failure/);
  });
});
