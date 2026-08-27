import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
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

export type SyncIntent = {
  mapping: MappingRow;
  audit: AuditEvent;
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

  private async syncClient(
    erpId: string,
    op: 'upsert' | 'delete',
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    if (op === 'delete') return this.deleteClient(erpId, event);
    const row = await this.deps.source.getClientById(erpId);
    if (!row) return this.deleteClient(erpId, event);
    const result = await this.upsertClientRow(row, event);
    return result.intent ? [result.intent] : [];
  }

  private async upsertClientRow(
    row: ClientRow,
    event: OutboxEventRecord,
  ): Promise<{ id: string; object: Bitrix24CounterpartyObject; intent: SyncIntent | null }> {
    const payload = mapClient(row, this.deps.options.assignedById);
    const mapping = await this.deps.mapping.get(this.deps.db, 'client', row.clientId);
    const bitrixOwned = mapping?.sourceSystem === 'bitrix24';
    const sameObject = mapping?.bitrixObject === payload.object;
    if (bitrixOwned && (!sameObject || !mapping.bitrixId || mapping.status !== 'active')) {
      throw new Error(
        `CRM sync: Bitrix-owned client ${row.clientId} cannot be reclassified or recreated automatically`,
      );
    }
    const fields = bitrixOwned
      ? omitFields(payload.fields, ['originatorId', 'originId', 'assignedById'])
      : payload.fields;
    const nextHash = hash({ object: payload.object, fields });
    const usableId =
      mapping?.status === 'active' && sameObject ? mapping.bitrixId : null;

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

    const bitrixId = await this.upsertCrmItem(
      payload.entityTypeId,
      payload.originId,
      fields,
      usableId,
    );
    const intent: SyncIntent = {
      mapping: {
        entityType: 'client',
        erpId: row.clientId,
        bitrixObject: payload.object,
        bitrixId,
        parentErpId: null,
        status: 'active',
        lastHash: nextHash,
      },
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
    if (op === 'delete') return this.deleteOrder(erpId, event);
    if (!order || order.deleteFlag) return this.deleteOrder(erpId, event);

    const intents: SyncIntent[] = [];
    const counterparty = await this.ensureCounterparty(order.clientId, event);
    if (counterparty.intent) intents.push(counterparty.intent);

    const payload = mapOrder(order, counterparty, this.deps.options);
    const bitrixOwned = mapping?.sourceSystem === 'bitrix24';
    const fields = bitrixOwned ? bitrixOwnedProductionFields(payload.fields) : payload.fields;
    const nextHash = hash({ fields, productRows: payload.productRows });
    const usableId =
      mapping?.status === 'active' && mapping.bitrixObject === 'deal'
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
    await this.deps.bitrix.setDealProductRows(dealId, payload.productRows);
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
    return this.upsertClientRow(client, event);
  }

  private async reconcilePayments(
    orderId: string,
    dealId: string,
    clientId: string,
    event: OutboxEventRecord,
  ): Promise<SyncIntent[]> {
    const current = await this.deps.source.getPaymentsByOrderId(orderId);
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
          await this.deps.bitrix.deletePayment(recoveredId);
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
          await this.deps.bitrix.deletePayment(candidateId);
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
      await this.deps.bitrix.deletePayment(recoveredOnOldDeal);
      await this.clearPaymentCreateGuard(payment.paymentId);
      guard = null;
    }

    // A successfully tagged payment is the strongest recovery signal. It must
    // also belong to the target Deal; sale.payment.update cannot re-parent it.
    if (foundByXmlId && targetPaymentIds.has(foundByXmlId)) {
      await this.deps.bitrix.updatePayment(foundByXmlId, payload.fields);
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
      if (obsoleteId !== bitrixId) await this.deps.bitrix.deletePayment(obsoleteId);
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
    await this.deps.bitrix.updatePayment(bitrixId, payload.fields);

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
          await this.deps.bitrix.deletePayment(recoveredId);
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
          await this.deps.bitrix.deletePayment(candidateId);
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
