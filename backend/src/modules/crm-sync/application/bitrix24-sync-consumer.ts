import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { AuditEvent, AuditRelatedEntity } from '../../../common/audit/audit-event.types';
import type { DatabaseService } from '../../../database/database.service';
import type {
  ClientRow,
  CrmSourcePort,
  MappingRow,
  PaymentCreateGuardRow,
  PaymentRow,
} from './crm-sync.types';
import {
  BITRIX24_ENTITY_TYPE,
  type Bitrix24CounterpartyObject,
  type Bitrix24MapperOptions,
  clientOriginId,
  hash,
  mapClient,
  mapOrder,
  mapPayment,
  orderOriginId,
  paymentXmlId,
} from './bitrix24-sync-mapper';
import {
  Bitrix24ApiError,
  type Bitrix24ApiPort,
  type Bitrix24RequestGuard,
} from '../adapters/bitrix24-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import { safeOutboundText } from './bitrix24-safe-text';
import type { Bitrix24PaidPaymentGuard } from './bitrix24-paid-payment-guard';

export type SyncIntent = {
  /** Absent for an event that writes no mapping (client merge comments): only the audit is persisted. */
  mapping?: MappingRow;
  audit: AuditEvent;
  /** Additional audit rows persisted with the intent (same transaction). */
  extraAudits?: AuditEvent[];
  clearPaymentCreateGuardId?: string;
};

export interface CrmSyncFailureTarget {
  entityType: 'client' | 'order' | 'payment';
  erpId: string;
  bitrixObject: 'contact' | 'company' | 'deal' | 'payment';
  relatedClientId?: number;
  relatedOrderId?: number;
  relatedPaymentId?: number;
}

/**
 * A delivery failure audited on its client that must not mark any mapping failed: the alias of a merged client (an
 * active mapping that requests of the survivor rely on, migration 268) and client merge comments.
 */
export class CrmSyncAuditOnlyError extends Error {
  constructor(
    readonly target: {
      erpId: string;
      relatedEntities: AuditRelatedEntity[];
      metadata: Record<string, unknown>;
    },
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'CrmSyncAuditOnlyError';
  }
}

export class CrmSyncTargetError extends Error {
  constructor(
    readonly target: CrmSyncFailureTarget,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'CrmSyncTargetError';
  }
}

interface Bitrix24SyncConsumerDeps {
  source: CrmSourcePort;
  bitrix: Bitrix24ApiPort;
  mapping: PgCrmSyncMappingRepository;
  db: DatabaseService;
  options: Bitrix24MapperOptions;
  durablePaymentCreates?: boolean;
  /** Changes/deletes paid ERP payments in Bitrix24; absent = plain calls (dry-run, legacy). */
  paidPayments?: Bitrix24PaidPaymentGuard;
  /** Assignment channel (migration 270): it alone writes `assignedById` of the objects it owns. */
  assignment?: { ownsAssignment(entityType: 'order' | 'client', erpId: string): Promise<boolean> };
}

export class Bitrix24SyncConsumer {
  constructor(private readonly deps: Bitrix24SyncConsumerDeps) {}

  supports(eventType: string): boolean {
    return eventType.startsWith('crm.sync.');
  }

  async sync(
    event: OutboxEventRecord,
    requestGuard?: Bitrix24RequestGuard,
  ): Promise<SyncIntent[]> {
    const operation = () => this.syncOwned(event);
    return requestGuard
      ? this.deps.bitrix.withRequestGuard(requestGuard, operation)
      : operation();
  }

  private async syncOwned(event: OutboxEventRecord): Promise<SyncIntent[]> {
    if (event.eventType === CLIENT_MERGED || event.eventType === CLIENT_MERGE_UNDONE) {
      return this.commentClientMerge(event);
    }
    const payload = event.payload as {
      entity?: unknown;
      id?: unknown;
      op?: unknown;
      clientId?: unknown;
    };
    const entity = payload.entity;
    const id = payload.id;
    const op = payload.op;

    if (entity !== 'client' && entity !== 'order') {
      throw new Error(`crm-sync: unknown entity '${String(entity)}' in event ${event.outboxEventId}`);
    }
    if (op !== 'upsert' && op !== 'delete') {
      throw new Error(`crm-sync: unknown op '${String(op)}' in event ${event.outboxEventId}`);
    }
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new Error(`crm-sync: invalid id '${String(id)}' in event ${event.outboxEventId}`);
    }
    if (
      payload.clientId != null &&
      (typeof payload.clientId !== 'string' || !/^\d+$/.test(payload.clientId))
    ) {
      throw new Error(
        `crm-sync: invalid clientId '${String(payload.clientId)}' in event ${event.outboxEventId}`,
      );
    }

    return entity === 'client'
      ? this.syncClient(id, op, event)
      : this.syncOrder(id, op, event);
  }

  /**
   * Client merge (migration 268): a comment in the timeline of the merged client's contact/company, no field is
   * changed. The marker in the text makes the create idempotent: a retry (lost answer included) first looks for it.
   */
  private async commentClientMerge(event: OutboxEventRecord): Promise<SyncIntent[]> {
    const payload = event.payload as { mergeId?: unknown; mergedClientId?: unknown; survivorId?: unknown };
    const mergeId = positiveId(payload.mergeId);
    const mergedId = positiveId(payload.mergedClientId);
    const survivorId = positiveId(payload.survivorId);
    if (mergeId === null || mergedId === null || survivorId === null || mergedId === survivorId) {
      throw new Error(`crm-sync: invalid client merge payload in event ${event.outboxEventId}`);
    }
    const undone = event.eventType === CLIENT_MERGE_UNDONE;
    const marker = `${undone ? 'ERP-MERGE-UNDO' : 'ERP-MERGE'}-${mergeId}`;
    const audit = (outcome: string, extra: Record<string, unknown> = {}): SyncIntent[] => [{
      audit: {
        event: 'crm_sync.client_merge_comment',
        entityType: 'client',
        entityId: mergedId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(mergedId),
        relatedEntities: [
          { entityType: 'client', entityId: Number(survivorId) },
          { entityType: 'client_merge', entityId: Number(mergeId) },
        ],
        metadata: { mergeId: Number(mergeId), survivorId: Number(survivorId), kind: undone ? 'merge_undone' : 'merged', outcome, ...extra },
      },
    }];

    try {
      return await this.deliverMergeComment(event, { mergeId, mergedId, survivorId, undone, marker }, audit);
    } catch (error) {
      throw new CrmSyncAuditOnlyError({
        erpId: mergedId,
        relatedEntities: [
          { entityType: 'client', entityId: Number(survivorId) },
          { entityType: 'client_merge', entityId: Number(mergeId) },
        ],
        metadata: { eventType: event.eventType, mergeId: Number(mergeId), survivorId: Number(survivorId) },
      }, error);
    }
  }

  private async deliverMergeComment(
    event: OutboxEventRecord,
    merge: { mergeId: string; mergedId: string; survivorId: string; undone: boolean; marker: string },
    audit: (outcome: string, extra?: Record<string, unknown>) => SyncIntent[],
  ): Promise<SyncIntent[]> {
    const { mergeId, mergedId, survivorId, undone, marker } = merge;
    const mapping = await this.deps.mapping.get(this.deps.db, 'client', mergedId);
    if (mapping?.status !== 'active' || !mapping.bitrixId) return audit('no_counterparty');
    const entity = toCounterpartyObject(mapping.bitrixObject);
    const target = { bitrixObject: entity, bitrixId: mapping.bitrixId };
    const { addTimelineComment, listTimelineComments } = this.deps.bitrix;
    if (!addTimelineComment || !listTimelineComments) return audit('comments_unavailable', target);

    const createdAt = event.createdAt ? new Date(event.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      throw new Error(`crm-sync: client merge event ${event.outboxEventId} has no creation time`);
    }
    // A merge comment delivered after its undo would tell a story that is no longer true.
    if (!undone && await this.deps.source.getClientMergeStatus?.(mergeId) === 'undone') {
      return audit('superseded', target);
    }
    const since = new Date(createdAt.getTime() - MINUTE);
    const existing = await listTimelineComments.call(this.deps.bitrix, entity, mapping.bitrixId, since);
    const markerPattern = new RegExp(`${marker}(?![0-9])`);
    const found = existing.comments.find((comment) => markerPattern.test(comment.comment));
    if (found) return audit('commented', { ...target, commentId: found.id, recovered: true });
    if (!existing.complete) {
      throw new Error(`CRM sync: timeline of ${entity} ${mapping.bitrixId} could not be read in full; merge comment ${marker} waits`);
    }

    const survivor = await this.deps.source.getClientById(survivorId);
    const survivorName = safeOutboundText(survivor?.clientName) || 'без названия';
    const day = createdAt.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
    const comment = undone
      ? `ERP, ${day}: объединение с клиентом «${survivorName}» (ERP №${survivorId}) отменено, клиент снова отдельный. ` +
        `Метка: ${marker}`
      : `ERP, ${day}: клиент объединён с клиентом «${survivorName}» (ERP №${survivorId}). Заказы и сделки этого ` +
        `клиента в ERP ведутся у него, новые сделки на этом контакте тоже попадут к нему. Метка: ${marker}`;
    try {
      const commentId = await addTimelineComment.call(this.deps.bitrix, entity, mapping.bitrixId, comment);
      return audit('commented', { ...target, commentId });
    } catch (error) {
      if (error instanceof Bitrix24ApiError && error.isNotFound) return audit('counterparty_missing', target);
      throw error;
    }
  }

  private async withoutOwnedAssignment(
    entityType: 'order' | 'client',
    erpId: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!('assignedById' in fields) || !this.deps.assignment) return fields;
    return await this.deps.assignment.ownsAssignment(entityType, erpId)
      ? omitFields(fields, ['assignedById'])
      : fields;
  }

  private async syncClient(
    erpId: string,
    op: 'upsert' | 'delete',
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    const row = await this.deps.source.getClientById(erpId);
    if (!row) return this.deleteClient(erpId, event);
    // Decided at execution: a delete event for a client that exists now is stale (e.g. a retried
    // old event) and must not remove its Contact/Company — the current state is projected instead.
    const result = await this.upsertClientRow(row, event);
    if (!result.intent) return [];
    if (op === 'delete') {
      result.intent.extraAudits = [staleDeleteAudit('client', erpId, event, Number(erpId), null)];
    }
    return [result.intent];
  }

  private async upsertClientRow(
    row: ClientRow,
    event: OutboxEventRecord,
  ): Promise<{ id: string; object: Bitrix24CounterpartyObject; intent: SyncIntent | null }> {
    const payload = mapClient(row, this.deps.options.assignedById);
    const mapping = await this.deps.mapping.get(this.deps.db, 'client', row.clientId);
    if (row.mergedIntoClientId) return this.updateMergedAlias(row, row.mergedIntoClientId, payload, mapping, event);
    const bitrixOwned = mapping?.sourceSystem === 'bitrix24';
    const sameObject = mapping?.bitrixObject === payload.object;
    if (bitrixOwned && (!sameObject || !mapping.bitrixId || mapping.status !== 'active')) {
      throw new Error(
        `CRM sync: Bitrix-owned client ${row.clientId} cannot be reclassified or recreated automatically`,
      );
    }
    const fields = bitrixOwned
      ? omitFields(payload.fields, ['originatorId', 'originId', 'assignedById'])
      : await this.withoutOwnedAssignment('client', row.clientId, payload.fields);
    const nextHash = hash({ object: payload.object, fields });
    const usableId =
      mapping?.status === 'active' && sameObject ? mapping.bitrixId : null;

    let bitrixId: string | null = null;
    if (usableId) {
      try {
        await this.deps.bitrix.updateCrmItem(payload.entityTypeId, usableId, fields);
        bitrixId = usableId;
      } catch (error) {
        if (!(error instanceof Bitrix24ApiError) || !error.isNotFound) throw error;
      }
    }
    if (bitrixId === null) {
      // Creating, finding or replacing a counterparty runs under the key a client merge takes exclusively
      // (`bitrix24-reverse:client:erp:<id>`, merge-state.ts advisoryKeys), with the redirect read again under it: a
      // merge that committed meanwhile turns this into the update-only path of its alias, and a merge that starts now
      // waits for these calls. A merge committing after them is caught when the mapping is persisted
      // (`persistSyncIntent` keeps the alias). Only an advisory lock is held over the calls, no row.
      type Locked = { kind: 'merged'; survivorId: string; row: ClientRow } | { kind: 'written'; bitrixId: string };
      const created = await this.deps.db.transaction(async (tx): Promise<Locked> => {
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`bitrix24-reverse:client:erp:${row.clientId}`]);
        const current = await this.deps.source.getClientById(row.clientId);
        if (current && current.mergedIntoClientId) return { kind: 'merged', survivorId: current.mergedIntoClientId, row: current };
        if (
          !bitrixOwned &&
          mapping?.status === 'active' &&
          mapping.bitrixId &&
          mapping.bitrixObject !== payload.object
        ) {
          const operationId = await this.deps.mapping.prepareOutboundOperation(
            this.deps.db,
            {
              objectType: toCounterpartyObject(mapping.bitrixObject),
              bitrixId: mapping.bitrixId,
              operation: 'delete',
            },
          );
          await this.deps.bitrix.deleteCrmItem(
            entityTypeIdForObject(mapping.bitrixObject),
            mapping.bitrixId,
          );
          await this.deps.mapping.completeOutboundOperation(
            this.deps.db,
            operationId,
          );
        }
        return { kind: 'written', bitrixId: await this.upsertCrmItem(payload.entityTypeId, payload.originId, fields, null) };
      });
      if (created.kind === 'merged') {
        const fresh = await this.deps.mapping.get(this.deps.db, 'client', row.clientId);
        return this.updateMergedAlias(created.row, created.survivorId, mapClient(created.row, this.deps.options.assignedById), fresh, event);
      }
      bitrixId = created.bitrixId;
    }
    const intent: SyncIntent = {
      mapping: clientMapping(row.clientId, payload.object, bitrixId, nextHash),
      audit: {
        event: 'crm_sync.upsert',
        entityType: 'client',
        entityId: row.clientId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(row.clientId),
        metadata: { bitrixId, bitrixObject: payload.object },
      },
    };
    return { id: bitrixId, object: payload.object, intent };
  }

  /**
   * A merged client (migration 268) keeps its contact/company only as an alias of the survivor: the alias is updated
   * (the «неактивен» status line reaches Bitrix24), never replaced, recreated or reclassified — a new counterparty
   * would orphan the alias that requests of the survivor may still point to.
   */
  private async updateMergedAlias(
    row: ClientRow,
    survivorId: string,
    payload: ReturnType<typeof mapClient>,
    mapping: MappingRow | null,
    event: OutboxEventRecord,
  ): Promise<{ id: string; object: Bitrix24CounterpartyObject; intent: SyncIntent | null }> {
    const skipped = (reason: string): { id: string; object: Bitrix24CounterpartyObject; intent: SyncIntent } => ({
      id: mapping?.bitrixId ?? '',
      object: payload.object,
      intent: {
        audit: {
          event: 'crm_sync.merged_client_skipped',
          entityType: 'client',
          entityId: row.clientId,
          requestId: event.outboxEventId,
          source: 'crm-sync',
          actorUserId: null,
          relatedClientId: Number(row.clientId),
          relatedEntities: [{ entityType: 'client', entityId: Number(survivorId) }],
          metadata: {
            survivorId: Number(survivorId),
            reason,
            bitrixObject: mapping?.bitrixObject ?? null,
            bitrixId: mapping?.bitrixId ?? null,
            mappingStatus: mapping?.status ?? null,
          },
        },
      },
    });
    // `failed` is the status a delivery failure left before (attempts of older code): the alias is still the same.
    if ((mapping?.status !== 'active' && mapping?.status !== 'failed') || !mapping.bitrixId || mapping.bitrixObject !== payload.object) {
      return skipped('no_alias');
    }
    const fields = mapping.sourceSystem === 'bitrix24'
      ? omitFields(payload.fields, ['originatorId', 'originId', 'assignedById'])
      : await this.withoutOwnedAssignment('client', row.clientId, payload.fields);
    try {
      await this.deps.bitrix.updateCrmItem(payload.entityTypeId, mapping.bitrixId, fields);
    } catch (error) {
      if (error instanceof Bitrix24ApiError && error.isNotFound) return skipped('alias_missing');
      // Retried, but the alias mapping is never marked failed: requests of the survivor may need it active (268).
      throw new CrmSyncAuditOnlyError({
        erpId: row.clientId,
        relatedEntities: [{ entityType: 'client', entityId: Number(survivorId) }],
        metadata: { survivorId: Number(survivorId), bitrixObject: mapping.bitrixObject, bitrixId: mapping.bitrixId },
      }, error);
    }
    return {
      id: mapping.bitrixId,
      object: payload.object,
      intent: {
        mapping: {
          entityType: 'client',
          erpId: row.clientId,
          bitrixObject: payload.object,
          bitrixId: mapping.bitrixId,
          parentErpId: null,
          status: 'active',
          lastHash: hash({ object: payload.object, fields }),
        },
        audit: {
          event: 'crm_sync.upsert',
          entityType: 'client',
          entityId: row.clientId,
          requestId: event.outboxEventId,
          source: 'crm-sync',
          actorUserId: null,
          relatedClientId: Number(row.clientId),
          metadata: { bitrixId: mapping.bitrixId, bitrixObject: payload.object, mergedIntoClientId: Number(survivorId) },
        },
      },
    };
  }

  private async deleteClient(
    erpId: string,
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    if (await this.deps.source.hasOrdersForClient(erpId)) return [];

    const mapping = await this.deps.mapping.get(this.deps.db, 'client', erpId);
    const mappedObject = toCounterpartyObject(mapping?.bitrixObject);
    const contactId = await this.deps.bitrix.findCrmItemByOrigin(
      BITRIX24_ENTITY_TYPE.contact,
      clientOriginId(erpId),
    );
    const companyId = await this.deps.bitrix.findCrmItemByOrigin(
      BITRIX24_ENTITY_TYPE.company,
      clientOriginId(erpId),
    );
    const candidates = new Map<string, {
      object: Bitrix24CounterpartyObject;
      id: string;
    }>();
    if (mapping?.bitrixId) {
      candidates.set(`${mappedObject}:${mapping.bitrixId}`, {
        object: mappedObject,
        id: mapping.bitrixId,
      });
    }
    if (contactId) candidates.set(`contact:${contactId}`, { object: 'contact', id: contactId });
    if (companyId) candidates.set(`company:${companyId}`, { object: 'company', id: companyId });
    if (candidates.size === 0 && !mapping) return [];

    for (const candidate of candidates.values()) {
      await this.deps.bitrix.deleteCrmItem(
        entityTypeIdForObject(candidate.object),
        candidate.id,
      );
    }
    const preferred = companyId
      ? { object: 'company' as const, id: companyId }
      : contactId
        ? { object: 'contact' as const, id: contactId }
        : mapping?.bitrixId
          ? { object: mappedObject, id: mapping.bitrixId }
          : null;
    const bitrixObject = preferred?.object ?? mappedObject;
    const bitrixId = preferred?.id ?? null;

    return [{
      mapping: {
        entityType: 'client',
        erpId,
        bitrixObject,
        bitrixId,
        parentErpId: null,
        status: 'deleted',
        lastHash: hash({ deleted: true }),
      },
      audit: {
        event: 'crm_sync.delete',
        entityType: 'client',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedClientId: Number(erpId),
        metadata: { bitrixId, bitrixObject },
      },
    }];
  }

  private async syncOrder(
    erpId: string,
    op: 'upsert' | 'delete',
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    const order = await this.deps.source.getOrderById(erpId);
    if (order && order.orderKind && order.orderKind !== 'production_order') return [];
    const mapping = await this.deps.mapping.get(this.deps.db, 'order', erpId);
    if (mapping?.sourceSystem === 'bitrix24' && mapping.status === 'remote_deleted') {
      return [{
        mapping: {
          ...mapping,
          status: 'remote_deleted',
          lastHash: hash({ remoteDeleted: true, orderVersion: event.outboxEventId }),
        },
        audit: {
          event: 'crm_sync.remote_deleted_skipped',
          entityType: 'order',
          entityId: erpId,
          requestId: event.outboxEventId,
          source: 'crm-sync',
          actorUserId: null,
          relatedOrderId: Number(erpId),
          relatedClientId: order?.clientId
            ? Number(order.clientId)
            : mapping.parentErpId
              ? Number(mapping.parentErpId)
              : null,
          metadata: {
            bitrixId: mapping.bitrixId,
            conflictCode: 'BITRIX24_DEAL_REMOTE_DELETED',
          },
        },
      }];
    }
    if (!order || order.deleteFlag) return this.deleteOrder(erpId, event);
    // Decided at execution: a delete event for an order that exists now is stale (e.g. a retried
    // old event) and must not remove its Deal and payments — the current state is projected instead.
    const staleDelete = op === 'delete';

    const intents: SyncIntent[] = [];
    const counterparty = await this.ensureCounterparty(order.clientId, event);
    if (counterparty.intent) intents.push(counterparty.intent);

    const payload = mapOrder(order, counterparty, this.deps.options);
    const bitrixOwned = mapping?.sourceSystem === 'bitrix24';
    const fields = bitrixOwned
      ? bitrixOwnedProductionFields(payload.fields)
      : await this.withoutOwnedAssignment('order', erpId, payload.fields);
    const nextHash = hash({ fields, productRows: payload.productRows });
    // A failed attempt keeps the last known Deal ID (markFailed never clears it). Dropping it would
    // send every retry to the portal-wide originId lookup, and a Bitrix-owned order could never recover.
    const usableId =
      (mapping?.status === 'active' || mapping?.status === 'failed') && mapping.bitrixObject === 'deal'
        ? mapping.bitrixId
        : null;
    let dealId = usableId;

    if (bitrixOwned) {
      if (!usableId) {
        throw new Error(`CRM sync: Bitrix-owned order ${erpId} has no active Deal mapping`);
      }
      await this.deps.bitrix.updateCrmItem(BITRIX24_ENTITY_TYPE.deal, usableId, fields);
      dealId = usableId;
    } else {
      dealId = await this.upsertCrmItem(
        BITRIX24_ENTITY_TYPE.deal,
        payload.originId,
        fields,
        usableId,
      );
    }
    // Bitrix-owned orders keep CRM-originated product rows authoritative:
    // outbound sync must not overwrite rows the portal owns and the importer
    // materialized locally. ERP-origin orders keep the full replacement.
    if (!bitrixOwned) {
      await this.deps.bitrix.setDealProductRows(dealId, payload.productRows);
    }
    intents.push({
        mapping: {
          entityType: 'order',
          erpId,
          bitrixObject: 'deal',
          bitrixId: dealId,
          parentErpId: order.clientId,
          status: 'active',
          lastHash: nextHash,
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
          metadata: {
            bitrixId: dealId,
            counterpartyId: counterparty.id,
            counterpartyObject: counterparty.object,
          },
        },
        extraAudits: staleDelete
          ? [staleDeleteAudit('order', erpId, event, Number(order.clientId), Number(erpId))]
          : undefined,
    });

    if (!dealId) {
      throw new Error(`CRM sync: no Bitrix deal ID resolved for ERP order ${erpId}`);
    }
    intents.push(...await this.reconcilePayments(
      order.orderId,
      dealId,
      order.clientId,
      event,
    ));
    return intents;
  }

  private async ensureCounterparty(
    clientId: string,
    event: OutboxEventRecord,
  ): Promise<{ id: string; object: Bitrix24CounterpartyObject; intent: SyncIntent | null }> {
    const client = await this.deps.source.getClientById(clientId);
    if (!client) {
      throw new Error(`CRM sync: order cannot be projected — client ${clientId} not found in ERP`);
    }
    if (client.mergedIntoClientId) {
      // Merge guards keep orders off merged clients; an order still here would take the alias as its counterparty.
      throw new Error(`CRM sync: order cannot be projected — client ${clientId} is merged into ${client.mergedIntoClientId}`);
    }
    const expectedObject: Bitrix24CounterpartyObject =
      client.personType === 'legal' ? 'company' : 'contact';
    const mapping = await this.deps.mapping.get(this.deps.db, 'client', clientId);
    if (
      mapping?.status === 'active' &&
      mapping.bitrixId &&
      mapping.bitrixObject === expectedObject
    ) {
      return { id: mapping.bitrixId, object: expectedObject, intent: null };
    }
    const result = await this.upsertClientRow(client, event);
    if (!result.intent?.mapping) {
      // The client was merged while this order was projected: the retry reads the order on its survivor.
      throw new Error(`CRM sync: order cannot be projected — client ${clientId} was merged meanwhile`);
    }
    return result;
  }

  private async reconcilePayments(
    orderId: string,
    dealId: string,
    clientId: string,
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    const current = await this.deps.source.getPaymentsByOrderId(orderId);
    await this.deps.paidPayments?.settleOrder(
      orderId,
      current.map((payment) => payment.paymentId),
      event.outboxEventId,
    );
    const mappedForOrder = await this.deps.mapping.listByParent(
      this.deps.db,
      'payment',
      orderId,
    );
    const currentIds = new Set(current.map((payment) => payment.paymentId));
    const intents: SyncIntent[] = [];
    const guardedDeletionIds = new Set<string>();

    for (const payment of current) {
      try {
        const intent = await this.upsertPayment(payment, dealId, event);
        if (intent) intents.push(intent);
      } catch (error) {
        throw new CrmSyncTargetError({
          entityType: 'payment',
          erpId: payment.paymentId,
          bitrixObject: 'payment',
          relatedClientId: Number(clientId),
          relatedOrderId: Number(payment.orderId),
          relatedPaymentId: Number(payment.paymentId),
        }, error);
      }
    }

    if (this.deps.durablePaymentCreates !== false) {
      const guards = await this.deps.mapping.listPaymentCreateGuardsByOrder(
        this.deps.db,
        orderId,
      );
      for (const guard of guards) {
        if (currentIds.has(guard.erpPaymentId)) continue;
        try {
          const recoveredId = await this.recoverGuardedPayment(guard);
          await this.removePayment(guard.erpPaymentId, guard.erpOrderId, guard.bitrixDealId, recoveredId, event);
          intents.push(this.paymentDeleteIntent(
            guard.erpPaymentId,
            orderId,
            recoveredId,
            event,
          ));
          guardedDeletionIds.add(guard.erpPaymentId);
        } catch (error) {
          throw new CrmSyncTargetError({
            entityType: 'payment',
            erpId: guard.erpPaymentId,
            bitrixObject: 'payment',
            relatedClientId: Number(clientId),
            relatedOrderId: Number(orderId),
            relatedPaymentId: Number(guard.erpPaymentId),
          }, error);
        }
      }
    }

    for (const mapping of mappedForOrder) {
      if (
        mapping.status === 'deleted' ||
        mapping.sourceSystem === 'bitrix24' ||
        currentIds.has(mapping.erpId) ||
        guardedDeletionIds.has(mapping.erpId)
      ) continue;
      try {
        const foundId = await this.deps.bitrix.findPaymentByXmlId(
          paymentXmlId(mapping.erpId),
        );
        const candidateIds = new Set(
          [mapping.bitrixId, foundId].filter((id): id is string => Boolean(id)),
        );
        for (const candidateId of candidateIds) {
          await this.removePayment(mapping.erpId, orderId, dealId, candidateId, event);
        }
        intents.push(this.paymentDeleteIntent(
          mapping.erpId,
          orderId,
          foundId ?? mapping.bitrixId,
          event,
        ));
      } catch (error) {
        throw new CrmSyncTargetError({
          entityType: 'payment',
          erpId: mapping.erpId,
          bitrixObject: 'payment',
          relatedClientId: Number(clientId),
          relatedOrderId: Number(orderId),
          relatedPaymentId: Number(mapping.erpId),
        }, error);
      }
    }

    return intents;
  }

  private async upsertPayment(
    payment: PaymentRow,
    dealId: string,
    event: OutboxEventRecord,
  ): Promise<SyncIntent | null> {
    // An unfinished paid-payment operation is finished before any discovery or create, then the
    // mapping and guard are read fresh.
    await this.deps.paidPayments?.settle(payment.paymentId, event.outboxEventId);
    const payload = mapPayment(payment, this.deps.options);
    const nextHash = hash(payload.fields);
    const mapping = await this.deps.mapping.get(this.deps.db, 'payment', payment.paymentId);
    if (mapping?.sourceSystem === 'bitrix24') return null;
    const sameDeal = mapping?.parentErpId === payment.orderId;
    let guard = this.deps.durablePaymentCreates === false
      ? null
      : await this.deps.mapping.getPaymentCreateGuard(this.deps.db, payment.paymentId);
    const targetPaymentIds = new Set(await this.deps.bitrix.listDealPaymentIds(dealId));
    const foundByXmlId = await this.deps.bitrix.findPaymentByXmlId(payload.xmlId);

    if (guard && guard.bitrixDealId !== dealId) {
      const recoveredOnOldDeal = await this.recoverGuardedPayment(guard);
      await this.removePayment(
        payment.paymentId,
        guard.erpOrderId,
        guard.bitrixDealId,
        recoveredOnOldDeal,
        event,
      );
      await this.clearPaymentCreateGuard(payment.paymentId);
      guard = null;
    }

    // A successfully tagged payment is the strongest recovery signal. It must
    // also belong to the target Deal; sale.payment.update cannot re-parent it.
    if (foundByXmlId && targetPaymentIds.has(foundByXmlId)) {
      await this.writePayment(payment, dealId, foundByXmlId, payload.fields, event);
      return this.paymentUpsertIntent(payment, dealId, foundByXmlId, nextHash, payload.xmlId, event);
    }

    // Recover an earlier create before considering any new create. A guard is
    // never discarded after an ambiguous attempt merely because a list call
    // returned zero: that is unknowable and must fail closed.
    let bitrixId: string | null = null;
    if (guard) {
      const recovered = await this.recoverGuardedPayment(guard);
      bitrixId = recovered;
    }

    // A mapped or XML-tagged payment on another Deal must be deleted and
    // recreated under the target Deal. Updating sale.payment fields does not
    // change its CRM owner.
    const obsoleteIds = new Set<string>();
    if (
      mapping?.status === 'active' &&
      mapping.bitrixId &&
      (!sameDeal || !targetPaymentIds.has(mapping.bitrixId))
    ) {
      obsoleteIds.add(mapping.bitrixId);
    }
    if (foundByXmlId && !targetPaymentIds.has(foundByXmlId)) {
      obsoleteIds.add(foundByXmlId);
    }
    for (const obsoleteId of obsoleteIds) {
      if (obsoleteId !== bitrixId) {
        await this.removePayment(
          payment.paymentId,
          mapping?.parentErpId ?? payment.orderId,
          null,
          obsoleteId,
          event,
        );
      }
    }

    if (
      !bitrixId &&
      mapping?.status === 'active' &&
      sameDeal &&
      mapping.bitrixId &&
      targetPaymentIds.has(mapping.bitrixId)
    ) {
      bitrixId = mapping.bitrixId;
    }

    if (!bitrixId) {
      bitrixId = await this.createGuardedPayment(payment, dealId, [...targetPaymentIds]);
    }

    // Keep the guard on every update failure. A retry recovers this exact
    // candidate and never calls crm.item.payment.add a second time.
    await this.writePayment(payment, dealId, bitrixId, payload.fields, event);

    return this.paymentUpsertIntent(
      payment,
      dealId,
      bitrixId,
      nextHash,
      payload.xmlId,
      event,
    );
  }

  private paymentUpsertIntent(
    payment: PaymentRow,
    dealId: string,
    bitrixId: string,
    lastHash: string,
    xmlId: string,
    event: OutboxEventRecord,
  ): SyncIntent {
    return {
      mapping: {
        entityType: 'payment',
        erpId: payment.paymentId,
        bitrixObject: 'payment',
        bitrixId,
        parentErpId: payment.orderId,
        status: 'active',
        lastHash,
      },
      audit: {
        event: 'crm_sync.upsert',
        entityType: 'payment',
        entityId: payment.paymentId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedOrderId: Number(payment.orderId),
        relatedPaymentId: Number(payment.paymentId),
        metadata: { bitrixId, dealId, xmlId },
      },
      clearPaymentCreateGuardId: payment.paymentId,
    };
  }

  private async createGuardedPayment(
    payment: PaymentRow,
    dealId: string,
    beforeIds: string[],
  ): Promise<string> {
    if (this.deps.durablePaymentCreates === false) {
      return this.deps.bitrix.createDealPayment(dealId);
    }

    const proposed: PaymentCreateGuardRow = {
      erpPaymentId: payment.paymentId,
      erpOrderId: payment.orderId,
      bitrixDealId: dealId,
      beforeIds,
    };
    const inserted = await this.deps.db.transaction((tx) =>
      this.deps.mapping.insertPaymentCreateGuard(tx, proposed));

    if (!inserted) {
      const existing = await this.deps.mapping.getPaymentCreateGuard(
        this.deps.db,
        payment.paymentId,
      );
      if (!existing) {
        throw new Error(
          `CRM sync: payment create guard race for ERP payment ${payment.paymentId}`,
        );
      }
      if (existing.bitrixDealId !== dealId) {
        throw new Error(
          `CRM sync: ERP payment ${payment.paymentId} has an unresolved create on Deal ` +
          `${existing.bitrixDealId}; target Deal is ${dealId}`,
        );
      }
      return this.recoverGuardedPayment(existing);
    }

    try {
      return await this.deps.bitrix.createDealPayment(dealId);
    } catch (error) {
      if (!isAmbiguousCreateFailure(error)) {
        await this.clearPaymentCreateGuard(payment.paymentId);
      }
      throw error;
    }
  }

  private async writePayment(
    payment: PaymentRow,
    dealId: string,
    bitrixId: string,
    fields: Record<string, unknown>,
    event: OutboxEventRecord,
  ): Promise<void> {
    if (!this.deps.paidPayments) {
      await this.deps.bitrix.updatePayment(bitrixId, fields);
      return;
    }
    const outcome = await this.deps.paidPayments.update({
      payment,
      dealId,
      bitrixId,
      fields,
      requestId: event.outboxEventId,
    });
    if (outcome !== 'applied') {
      // The Bitrix payment is gone: never record it as synced. The operation already queued a
      // fresh projection; this event is retried and will create the payment anew.
      throw new Error(
        `CRM sync: Bitrix payment ${bitrixId} of ERP payment ${payment.paymentId} is gone ` +
        `(${outcome}); the order is queued for a fresh projection`,
      );
    }
  }

  private async removePayment(
    erpPaymentId: string,
    erpOrderId: string,
    dealId: string | null,
    bitrixId: string,
    event: OutboxEventRecord,
  ): Promise<void> {
    if (!this.deps.paidPayments) {
      await this.deps.bitrix.deletePayment(bitrixId);
      return;
    }
    await this.deps.paidPayments.delete({
      erpPaymentId,
      erpOrderId,
      dealId,
      bitrixId,
      requestId: event.outboxEventId,
    });
  }

  private async recoverGuardedPayment(guard: PaymentCreateGuardRow): Promise<string> {
    const before = new Set(guard.beforeIds);
    const current = await this.deps.bitrix.listDealPaymentIds(guard.bitrixDealId);
    const candidates = current.filter((id) => !before.has(id));
    if (candidates.length === 1) return candidates[0];

    throw new Error(
      `CRM sync: ambiguous Bitrix payment create for ERP payment ${guard.erpPaymentId}; ` +
      `Deal ${guard.bitrixDealId} has ${candidates.length} recovery candidates. ` +
      'Automatic create is blocked to prevent duplicates.',
    );
  }

  private async clearPaymentCreateGuard(paymentId: string): Promise<void> {
    if (this.deps.durablePaymentCreates === false) return;
    await this.deps.mapping.deletePaymentCreateGuard(this.deps.db, paymentId);
  }

  private async deleteOrder(
    erpId: string,
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    await this.deps.paidPayments?.settleOrder(erpId, [], event.outboxEventId);
    const mapping = await this.deps.mapping.get(this.deps.db, 'order', erpId);
    const payload = event.payload as { clientId?: string | null };
    const clientId = payload.clientId ?? mapping?.parentErpId ?? null;
    const relatedClientId =
      typeof clientId === 'string' && /^\d+$/.test(clientId)
        ? Number(clientId)
        : undefined;
    const intents: SyncIntent[] = [];
    const guardedDeletionIds = new Set<string>();
    if (this.deps.durablePaymentCreates !== false) {
      const guards = await this.deps.mapping.listPaymentCreateGuardsByOrder(
        this.deps.db,
        erpId,
      );
      for (const guard of guards) {
        try {
          const recoveredId = await this.recoverGuardedPayment(guard);
          await this.removePayment(guard.erpPaymentId, guard.erpOrderId, guard.bitrixDealId, recoveredId, event);
          intents.push(this.paymentDeleteIntent(
            guard.erpPaymentId,
            erpId,
            recoveredId,
            event,
          ));
          guardedDeletionIds.add(guard.erpPaymentId);
        } catch (error) {
          throw new CrmSyncTargetError({
            entityType: 'payment',
            erpId: guard.erpPaymentId,
            bitrixObject: 'payment',
            relatedClientId,
            relatedOrderId: Number(erpId),
            relatedPaymentId: Number(guard.erpPaymentId),
          }, error);
        }
      }
    }
    const paymentMappings = await this.deps.mapping.listByParent(
      this.deps.db,
      'payment',
      erpId,
    );
    for (const paymentMapping of paymentMappings) {
      if (
        paymentMapping.status === 'deleted' ||
        paymentMapping.sourceSystem === 'bitrix24' ||
        guardedDeletionIds.has(paymentMapping.erpId)
      ) continue;
      try {
        const foundId = await this.deps.bitrix.findPaymentByXmlId(
          paymentXmlId(paymentMapping.erpId),
        );
        const candidateIds = new Set(
          [paymentMapping.bitrixId, foundId].filter((id): id is string => Boolean(id)),
        );
        for (const candidateId of candidateIds) {
          await this.removePayment(
            paymentMapping.erpId,
            erpId,
            mapping?.bitrixId ?? null,
            candidateId,
            event,
          );
        }
        intents.push(this.paymentDeleteIntent(
          paymentMapping.erpId,
          erpId,
          foundId ?? paymentMapping.bitrixId,
          event,
        ));
      } catch (error) {
        throw new CrmSyncTargetError({
          entityType: 'payment',
          erpId: paymentMapping.erpId,
          bitrixObject: 'payment',
          relatedClientId,
          relatedOrderId: Number(erpId),
          relatedPaymentId: Number(paymentMapping.erpId),
        }, error);
      }
    }

    const foundDealId = await this.deps.bitrix.findCrmItemByOrigin(
      BITRIX24_ENTITY_TYPE.deal,
      orderOriginId(erpId),
    );
    const dealIds = new Set(
      [mapping?.bitrixId ?? null, foundDealId].filter((id): id is string => Boolean(id)),
    );
    for (const dealId of dealIds) {
      await this.deps.bitrix.deleteCrmItem(BITRIX24_ENTITY_TYPE.deal, dealId);
    }
    const dealId = foundDealId ?? mapping?.bitrixId ?? null;
    if (!dealId && !mapping && intents.length === 0) return [];

    intents.push({
      mapping: {
        entityType: 'order',
        erpId,
        bitrixObject: 'deal',
        bitrixId: dealId,
        parentErpId: clientId,
        status: 'deleted',
        lastHash: hash({ deleted: true }),
      },
      audit: {
        event: 'crm_sync.delete',
        entityType: 'order',
        entityId: erpId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedOrderId: Number(erpId),
        relatedClientId: clientId == null ? null : Number(clientId),
        metadata: { bitrixId: dealId },
      },
    });
    return intents;
  }

  private paymentDeleteIntent(
    paymentId: string,
    orderId: string,
    bitrixId: string | null,
    event: OutboxEventRecord,
  ): SyncIntent {
    return {
      mapping: {
        entityType: 'payment',
        erpId: paymentId,
        bitrixObject: 'payment',
        bitrixId,
        parentErpId: orderId,
        status: 'deleted',
        lastHash: hash({ deleted: true }),
      },
      audit: {
        event: 'crm_sync.delete',
        entityType: 'payment',
        entityId: paymentId,
        requestId: event.outboxEventId,
        source: 'crm-sync',
        actorUserId: null,
        relatedOrderId: Number(orderId),
        relatedPaymentId: Number(paymentId),
        metadata: { bitrixId },
      },
      clearPaymentCreateGuardId: paymentId,
    };
  }

  private async upsertCrmItem(
    entityTypeId: number,
    originId: string,
    fields: Record<string, unknown>,
    existingId: string | null,
  ): Promise<string> {
    if (existingId) {
      try {
        await this.deps.bitrix.updateCrmItem(entityTypeId, existingId, fields);
        return existingId;
      } catch (error) {
        if (!(error instanceof Bitrix24ApiError) || !error.isNotFound) throw error;
      }
    }

    const found = await this.deps.bitrix.findCrmItemByOrigin(entityTypeId, originId);
    if (found) {
      await this.deps.bitrix.updateCrmItem(entityTypeId, found, fields);
      return found;
    }
    return this.deps.bitrix.createCrmItem(entityTypeId, fields);
  }
}

const CLIENT_MERGED = 'crm.sync.client.merged';
const CLIENT_MERGE_UNDONE = 'crm.sync.client.merge_undone';
const MINUTE = 60_000;

function clientMapping(erpId: string, object: Bitrix24CounterpartyObject, bitrixId: string, lastHash: string): MappingRow {
  return { entityType: 'client', erpId, bitrixObject: object, bitrixId, parentErpId: null, status: 'active', lastHash };
}

function positiveId(value: unknown): string | null {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9][0-9]{0,18}$/.test(text) ? text : null;
}

function toCounterpartyObject(value: string | undefined): Bitrix24CounterpartyObject {
  return value === 'company' ? 'company' : 'contact';
}

function entityTypeIdForObject(value: string): number {
  return value === 'company' ? BITRIX24_ENTITY_TYPE.company : BITRIX24_ENTITY_TYPE.contact;
}

function omitFields(
  fields: Record<string, unknown>,
  omitted: readonly string[],
): Record<string, unknown> {
  const result = { ...fields };
  for (const key of omitted) delete result[key];
  return result;
}

function bitrixOwnedProductionFields(fields: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'title',
    'additionalInfo',
    'begindate',
    'closedate',
    'companyId',
    'contactId',
  ]);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
}

function isAmbiguousCreateFailure(error: unknown): boolean {
  if (!(error instanceof Bitrix24ApiError)) return true;
  return (
    error.status === 0 ||
    error.status >= 500 ||
    error.code === 'INVALID_JSON' ||
    error.code === 'UNEXPECTED_RESPONSE'
  );
}

function staleDeleteAudit(
  entityType: 'client' | 'order',
  erpId: string,
  event: OutboxEventRecord,
  relatedClientId: number | null,
  relatedOrderId: number | null,
): AuditEvent {
  return {
    event: 'crm_sync.stale_delete_projected',
    entityType,
    entityId: erpId,
    requestId: event.outboxEventId,
    source: 'crm-sync',
    actorUserId: null,
    relatedClientId,
    relatedOrderId,
    metadata: { eventType: event.eventType, reason: 'entity_exists_at_execution' },
  };
}
