import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import type { DatabaseService } from '../../../database/database.service';
import type { CrmSourcePort, MappingRow } from './crm-sync.types';
import type { TwentyApiPort, TwentyObject } from '../adapters/twenty-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import { mapClient, mapOrder, hash, erpStatusFor } from './twenty-sync-mapper';

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
    const payload = event.payload as { entity: 'client' | 'order'; id: string; op: 'upsert' | 'delete'; clientId?: string | null };
    const { entity, id, op } = payload;

    // Fail-closed validation: a malformed/unknown event must throw so the relay's
    // catch runs markRetry (retryable → eventually 'failed' and visible) instead of
    // silently marking the row 'processed' and dropping the event forever.
    if (entity !== 'client' && entity !== 'order') {
      throw new Error(`crm-sync: unknown entity '${entity}' in event ${event.outboxEventId}`);
    }
    if (op !== 'upsert' && op !== 'delete') {
      throw new Error(`crm-sync: unknown op '${op}' in event ${event.outboxEventId}`);
    }
    // The id must be a structurally-valid ERP id (positive bigint as string).
    // A missing/garbled id would otherwise resolve to null in getClientById/getOrderById,
    // hit `if (!row) return []`, and be PERMANENTLY marked processed (silent drop).
    // Throwing routes it through the relay's markRetry/markFailed (retryable/visible).
    // NOTE: a well-formed id whose ERP row no longer exists is still a legitimate []
    // no-op handled downstream; this only rejects STRUCTURALLY-malformed payloads.
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new Error(`crm-sync: invalid id '${id}' in event ${event.outboxEventId}`);
    }
    // clientId is carried in the payload for order events (the order row may be gone
    // on hard delete). A null/absent clientId stays allowed (relatedClientId → null);
    // a present-but-non-numeric clientId is malformed and must fail closed.
    if (
      payload.clientId != null &&
      (typeof payload.clientId !== 'string' || !/^\d+$/.test(payload.clientId))
    ) {
      throw new Error(
        `crm-sync: invalid clientId '${payload.clientId}' in event ${event.outboxEventId}`,
      );
    }

    if (entity === 'client') {
      return this.syncClient(id, op, event);
    }
    return this.syncOrder(id, op, event);
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
    // Create, recovering from a concurrent create (erpId unique conflict). In a
    // relay/backfill overlap two workers can both find null then both create; the
    // loser hits a uniqueness conflict. Re-resolve and update instead of failing.
    try {
      const { id } = await this.twenty.createRecord(object, body);
      return id;
    } catch (createErr) {
      const conflictId = await this.twenty.findIdByErpId(object, erpId);
      if (conflictId) {
        await this.twenty.updateRecord(object, conflictId, body);
        return conflictId;
      }
      throw createErr; // genuine failure, not a race
    }
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
    const existingId = m?.twentyId ?? await this.twenty.findIdByErpId('companies', erpId);
    const deleteBody = { erpStatus: 'deleted' };

    if (existingId) {
      // A Twenty record exists → tombstone it (PATCH) and converge the mapping.
      await this.twenty.updateRecord('companies', existingId, deleteBody);
    } else if (!m) {
      // No mapping row AND no Twenty record → entity was never synced/tracked; nothing to converge.
      return [];
    }
    // else: a mapping row EXISTS but there is no Twenty record (e.g. a prior failed
    // create left status='failed', twenty_id=null). Converge the mapping to 'deleted'
    // and record the delete audit WITHOUT any Twenty call.

    const intent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId,
        twentyObject: 'companies',
        twentyId: existingId,
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
        metadata: { twentyId: existingId },
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

    // No-op: already synced with the same hash (active OR deleted; only 'failed' must re-sync)
    if (m && m.twentyId && m.status !== 'failed' && m.lastHash === h) {
      return [];
    }

    const twentyId = await this.upsertRecord('companies', body, erpId, m?.twentyId ?? null);
    const status = erpStatusFor(!row.isActive);

    const intent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId,
        twentyObject: 'companies',
        twentyId,
        status,
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
    const existingId = m?.twentyId ?? await this.twenty.findIdByErpId('erpOrders', erpId);
    const deleteBody = { erpStatus: 'deleted' };

    if (existingId) {
      // A Twenty record exists → tombstone it (PATCH) and converge the mapping.
      await this.twenty.updateRecord('erpOrders', existingId, deleteBody);
    } else if (!m) {
      // No mapping row AND no Twenty record → entity was never synced/tracked; nothing to converge.
      return [];
    }
    // else: a mapping row EXISTS but there is no Twenty record. Converge the mapping
    // to 'deleted' and record the delete audit WITHOUT any Twenty call.

    // clientId is carried via the outbox payload (order row already gone on hard delete)
    const payload = event.payload as { clientId?: string | null };
    const clientId = payload.clientId != null ? payload.clientId : null;

    const intent: SyncIntent = {
      mapping: {
        entityType: 'order',
        erpId,
        twentyObject: 'erpOrders',
        twentyId: existingId,
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
        relatedClientId: clientId != null ? Number(clientId) : null,
        metadata: { twentyId: existingId },
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
    // 'failed' must always re-sync; 'active' or 'deleted' with matching hash → no-op
    if (m && m.twentyId && m.status !== 'failed' && m.lastHash === h) {
      return intents;
    }

    const twentyId = await this.upsertRecord('erpOrders', body, erpId, m?.twentyId ?? null);

    const orderIntent: SyncIntent = {
      mapping: {
        entityType: 'order',
        erpId,
        twentyObject: 'erpOrders',
        twentyId,
        status: erpStatusFor(order.deleteFlag),
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

    // Usable: mapping exists, has a valid twentyId, AND is not failed.
    // A 'deleted' mapping still has a valid twentyId and is a valid relation target;
    // only 'failed' or null twentyId requires re-sync.
    if (cm && cm.twentyId && cm.status !== 'failed') {
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
        status: erpStatusFor(!clientRow.isActive),
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
