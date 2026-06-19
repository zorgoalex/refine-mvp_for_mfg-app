import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import type { DatabaseService } from '../../../database/database.service';
import type { CrmSourcePort, MappingRow } from './crm-sync.types';
import type { TwentyApiPort, TwentyObject } from '../adapters/twenty-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import { mapClient, mapOrder, hash } from './twenty-sync-mapper';

/** A persistence intent returned by TwentySyncConsumer. Persisted by the relay (Task 8). */
export type SyncIntent = {
  mapping: MappingRow;
  audit: AuditEvent;
};

interface TwentySyncConsumerDeps {
  source: CrmSourcePort;
  twenty: TwentyApiPort;
  mapping: PgCrmSyncMappingRepository;
  db: DatabaseService;
}

/**
 * Core ERP→Twenty sync logic.
 *
 * Reads from ERP (pool, read-only) and calls Twenty HTTP API.
 * Returns an ordered list of SyncIntent for the relay to persist in one TX.
 * NEVER does DB writes — no client.query INSERT/UPDATE here.
 */
export class TwentySyncConsumer {
  private readonly source: CrmSourcePort;
  private readonly twenty: TwentyApiPort;
  private readonly mapping: PgCrmSyncMappingRepository;
  private readonly db: DatabaseService;

  constructor(deps: TwentySyncConsumerDeps) {
    this.source = deps.source;
    this.twenty = deps.twenty;
    this.mapping = deps.mapping;
    this.db = deps.db;
  }

  /** True for all crm.sync.* events. */
  supports(eventType: string): boolean {
    return eventType.startsWith('crm.sync.');
  }

  /**
   * Execute ERP reads + Twenty HTTP for one outbox event.
   * Returns [] for genuine no-ops (hash unchanged, not mapped on delete).
   * Throws on unrecoverable errors so the relay can mark the event as failed.
   */
  async sync(event: OutboxEventRecord): Promise<SyncIntent[]> {
    const payload = event.payload as { entity: 'client' | 'order'; id: string; op: 'upsert' | 'delete' };
    const { entity, id, op } = payload;

    if (entity === 'client') {
      return this.syncClient(id, op, event);
    }
    if (entity === 'order') {
      return this.syncOrder(id, op, event);
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Shared idempotent upsert helper
  // ---------------------------------------------------------------------------

  /**
   * If existingTwentyId is known → PATCH it.
   * If not → findIdByErpId first (recovers post-rollback retries without duplicating),
   * then create if still not found.
   * Returns the resolved Twenty ID.
   */
  private async upsertRecord(
    object: TwentyObject,
    body: Record<string, unknown>,
    erpId: string,
    existingTwentyId: string | null,
  ): Promise<string> {
    if (existingTwentyId) {
      await this.twenty.updateRecord(object, existingTwentyId, body);
      return existingTwentyId;
    }
    // No known Twenty ID — try to find the record first (idempotency)
    const found = await this.twenty.findIdByErpId(object, erpId);
    if (found) {
      await this.twenty.updateRecord(object, found, body);
      return found;
    }
    const { id } = await this.twenty.createRecord(object, body);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Client sync
  // ---------------------------------------------------------------------------

  private async syncClient(
    erpId: string,
    op: 'upsert' | 'delete',
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    if (op === 'delete') {
      return this.softDeleteClient(erpId, event);
    }
    return this.upsertClient(erpId, event);
  }

  private async softDeleteClient(erpId: string, event: OutboxEventRecord): Promise<SyncIntent[]> {
    const m = await this.mapping.get(this.db, 'client', erpId);
    if (!m?.twentyId) return [];

    const deleteBody = { erpStatus: 'deleted' };
    await this.twenty.updateRecord('companies', m.twentyId, deleteBody);

    const intent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId,
        twentyObject: 'companies',
        twentyId: m.twentyId,
        status: 'deleted',
        lastHash: hash(deleteBody),
      },
      audit: {
        event: 'crm_sync.softdelete',
        entityType: 'client',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(erpId),
        metadata: { twentyId: m.twentyId },
      },
    };
    return [intent];
  }

  private async upsertClient(erpId: string, event: OutboxEventRecord): Promise<SyncIntent[]> {
    const row = await this.source.getClientById(erpId);
    if (!row) return []; // hard-deleted after enqueue

    const body = mapClient(row);
    const h = hash(body);
    const m = await this.mapping.get(this.db, 'client', erpId);

    // No-op: already synced with the same hash
    if (m && m.twentyId && m.status === 'active' && m.lastHash === h) {
      return [];
    }

    const twentyId = await this.upsertRecord('companies', body, erpId, m?.twentyId ?? null);

    const intent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId,
        twentyObject: 'companies',
        twentyId,
        status: 'active',
        lastHash: h,
      },
      audit: {
        event: 'crm_sync.upsert',
        entityType: 'client',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(erpId),
        metadata: { twentyId },
      },
    };
    return [intent];
  }

  // ---------------------------------------------------------------------------
  // Order sync
  // ---------------------------------------------------------------------------

  private async syncOrder(
    erpId: string,
    op: 'upsert' | 'delete',
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    if (op === 'delete') {
      return this.softDeleteOrder(erpId, event);
    }
    return this.upsertOrder(erpId, event);
  }

  private async softDeleteOrder(erpId: string, event: OutboxEventRecord): Promise<SyncIntent[]> {
    const m = await this.mapping.get(this.db, 'order', erpId);
    if (!m?.twentyId) return [];

    const deleteBody = { erpStatus: 'deleted' };
    await this.twenty.updateRecord('erpOrders', m.twentyId, deleteBody);

    const intent: SyncIntent = {
      mapping: {
        entityType: 'order',
        erpId,
        twentyObject: 'erpOrders',
        twentyId: m.twentyId,
        status: 'deleted',
        lastHash: hash(deleteBody),
      },
      audit: {
        event: 'crm_sync.softdelete',
        entityType: 'order',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedOrderId: Number(erpId),
        metadata: { twentyId: m.twentyId },
      },
    };
    return [intent];
  }

  private async upsertOrder(erpId: string, event: OutboxEventRecord): Promise<SyncIntent[]> {
    const order = await this.source.getOrderById(erpId);
    if (!order) return []; // hard-deleted after enqueue

    const intents: SyncIntent[] = [];

    // Ensure Company exists in Twenty; push clientIntent into intents if we had to sync it
    const companyId = await this.ensureCompany(order.clientId, intents, event);

    const body = mapOrder(order, companyId);
    const h = hash(body);
    const m = await this.mapping.get(this.db, 'order', erpId);

    // No-op for the order itself (but still return any client intent already pushed)
    if (m && m.twentyId && m.status === 'active' && m.lastHash === h) {
      return intents;
    }

    const twentyId = await this.upsertRecord('erpOrders', body, erpId, m?.twentyId ?? null);

    const orderIntent: SyncIntent = {
      mapping: {
        entityType: 'order',
        erpId,
        twentyObject: 'erpOrders',
        twentyId,
        status: 'active',
        lastHash: h,
      },
      audit: {
        event: 'crm_sync.upsert',
        entityType: 'order',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedOrderId: Number(erpId),
        relatedClientId: Number(order.clientId),
        metadata: { twentyId, companyId },
      },
    };
    intents.push(orderIntent);
    return intents;
  }

  /**
   * Resolves the Twenty Company ID for the given ERP client.
   * If the client mapping is missing OR has no usable twentyId (null/failed),
   * runs the full client upsert path, pushes a clientIntent into `intents`,
   * and returns the resolved companyId.
   * Throws if the client row itself is missing (order cannot project without client).
   */
  private async ensureCompany(
    clientId: string,
    intents: SyncIntent[],
    event: OutboxEventRecord,
  ): Promise<string> {
    const cm = await this.mapping.get(this.db, 'client', clientId);

    // Usable: mapping exists, has a valid twentyId, AND is active (not failed/deleted)
    if (cm && cm.twentyId && cm.status === 'active') {
      return cm.twentyId;
    }

    // Missing or unusable mapping (null twentyId, failed, etc.) — re-run client sync
    const clientRow = await this.source.getClientById(clientId);
    if (!clientRow) {
      throw new Error(
        `CRM sync: order cannot be projected — client ${clientId} not found in ERP`,
      );
    }

    const body = mapClient(clientRow);
    const h = hash(body);
    const companyId = await this.upsertRecord('companies', body, clientId, cm?.twentyId ?? null);

    const clientIntent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId: clientId,
        twentyObject: 'companies',
        twentyId: companyId,
        status: 'active',
        lastHash: h,
      },
      audit: {
        event: 'crm_sync.upsert',
        entityType: 'client',
        entityId: clientId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(clientId),
        metadata: { twentyId: companyId },
      },
    };
    intents.push(clientIntent);
    return companyId;
  }
}
