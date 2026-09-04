import type { Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import { Bitrix24ApiError } from '../adapters/bitrix24-api-client';
import { ApiError } from '../../../common/errors/api-error';
import { BITRIX24_ENTITY_TYPE } from '../application/bitrix24-sync-mapper';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import {
  bitrixCounterparty,
  normalizeBitrixClient,
  normalizeBitrixDeal,
  normalizeBitrixPayment,
  paymentIsErpOrigin,
} from './bitrix24-reverse-normalizer';
import type { Bitrix24InboundEventRow } from './bitrix24-reverse.types';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

export class Bitrix24ReverseProcessorService {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly bitrix: Bitrix24ApiPort,
    private readonly config: CrmSyncRuntimeConfigService,
  ) {}

  async assertReady(): Promise<void> {
    const flags = this.config.getReverseSync();
    await this.repository.assertReverseSyncReady(
      requireActorUserId(flags.actorUserId),
    );
  }

  async runTick(): Promise<{ claimed: number; processed: number; failed: number }> {
    const flags = this.config.getReverseSync();
    if (
      !flags.enabled ||
      flags.relayOwner === 'none' ||
      flags.dryRun
    ) {
      return { claimed: 0, processed: 0, failed: 0 };
    }

    const events = await this.repository.claimEvents({
      workerId: flags.workerId,
      batchSize: flags.batchSize,
      leaseMs: flags.leaseMs,
    });
    let processed = 0;
    let failed = 0;
    for (const event of events) {
      let ownershipLost = false;
      let heartbeatRunning = false;
      const heartbeat = async () => {
        if (heartbeatRunning || ownershipLost) return;
        heartbeatRunning = true;
        try {
          ownershipLost = !await this.repository.heartbeatEvent(event);
        } catch {
          ownershipLost = true;
        } finally {
          heartbeatRunning = false;
        }
      };
      const proveOwnership = async () => {
        if (!await this.repository.heartbeatEvent(event)) {
          ownershipLost = true;
          throw new Error('Bitrix24 reverse event ownership lost');
        }
      };
      await heartbeat();
      if (ownershipLost) continue;
      const heartbeatTimer = setInterval(
        () => void heartbeat(),
        Math.max(1000, Math.floor(flags.leaseMs / 3)),
      );
      heartbeatTimer.unref();
      try {
        await this.bitrix.withRequestGuard(
          proveOwnership,
          () => this.processEvent(event, flags.portalDomain),
        );
        await heartbeat();
        if (ownershipLost) continue;
        if (await this.repository.markEventProcessed(event)) {
          processed += 1;
        } else {
          ownershipLost = true;
        }
      } catch (error) {
        if (ownershipLost) continue;
        await this.repository.markEventFailed(
          event,
          safeError(error),
          flags.maxAttempts,
        );
        failed += 1;
      } finally {
        clearInterval(heartbeatTimer);
      }
    }
    return { claimed: events.length, processed, failed };
  }

  async runReconcileTick(): Promise<number> {
    const flags = this.config.getReverseSync();
    if (!flags.enabled || flags.relayOwner === 'none' || flags.dryRun) return 0;
    return this.repository.enqueueNextDealReconcileBatch({
      batchSize: flags.batchSize,
      intervalMs: flags.reconcileIntervalMs,
    });
  }

  async reconcileMappedOrderPaymentsNow(input: {
    dealId: string;
    orderId: number;
    auditRequestId: string;
  }): Promise<void> {
    const flags = this.config.getReverseSync();
    if (!flags.enabled || flags.dryRun) {
      throw new ApiError(
        503,
        'BITRIX24_REVERSE_SYNC_DISABLED',
        'Bitrix24 reverse synchronization is not active',
      );
    }
    await this.assertReady();
    await this.reconcileMappedOrderPayments(
      input.dealId,
      input.orderId,
      input.auditRequestId,
      undefined,
    );
  }

  private async processEvent(
    event: Bitrix24InboundEventRow,
    portalDomain: string,
  ): Promise<void> {
    if (event.operation === 'delete') {
      // A delayed/out-of-order delete must not archive an object that currently
      // exists. Fetch first; only a real not-found is treated as deletion.
      try {
        const item = await this.bitrix.getCrmItem(
          entityTypeId(event.objectType),
          event.bitrixId,
        );
        await this.processCurrent(
          event.objectType,
          event.bitrixId,
          item,
          portalDomain,
          event.inboundEventId,
          event.lockToken,
        );
        return;
      } catch (error) {
        if (!(error instanceof Bitrix24ApiError) || !error.isNotFound) throw error;
      }

      if (event.objectType === 'deal') {
        await this.repository.archiveDeal(
          event.bitrixId,
          event.inboundEventId,
          event.lockToken,
          this.config.getReverseSync().actorUserId ?? undefined,
        );
      } else {
        await this.repository.archiveClient(
          event.objectType,
          event.bitrixId,
          event.inboundEventId,
          event.lockToken,
        );
      }
      return;
    }

    let item: Record<string, unknown>;
    try {
      item = await this.bitrix.getCrmItem(
        entityTypeId(event.objectType),
        event.bitrixId,
      );
    } catch (error) {
      if (!(error instanceof Bitrix24ApiError) || !error.isNotFound) throw error;
      if (event.objectType === 'deal') {
        await this.repository.archiveDeal(
          event.bitrixId,
          event.inboundEventId,
          event.lockToken,
          this.config.getReverseSync().actorUserId ?? undefined,
        );
      } else {
        await this.repository.archiveClient(
          event.objectType,
          event.bitrixId,
          event.inboundEventId,
          event.lockToken,
        );
      }
      return;
    }
    await this.processCurrent(
      event.objectType,
      event.bitrixId,
      item,
      portalDomain,
      event.inboundEventId,
      event.lockToken,
    );
  }

  private async processCurrent(
    objectType: Bitrix24InboundEventRow['objectType'],
    bitrixId: string,
    item: Record<string, unknown>,
    portalDomain: string,
    requestId: string,
    lockToken: string,
  ): Promise<void> {
    if (objectType !== 'deal') {
      await this.repository.upsertClient(
        normalizeBitrixClient(objectType, bitrixId, item),
        requestId,
        lockToken,
      );
      return;
    }

    let clientId: number | null = null;
    const originOrderId = originId(item, 'ORDER');
    if (originOrderId) {
      const orderMapping = await this.repository.findMappingByErp('order', originOrderId);
      if (orderMapping?.parentErpId) clientId = Number(orderMapping.parentErpId);
    }

    const counterparty = bitrixCounterparty(item);
    if (counterparty) {
      const mapping = await this.repository.findMappingByBitrix(
        counterparty.objectType,
        counterparty.bitrixId,
      );
      if (mapping?.entityType === 'client') {
        clientId = Number(mapping.erpId);
      } else {
        clientId = null;
      }
    }

    const reverseConfig = this.config.getReverseSync();
    const result = await this.repository.upsertDeal(
      normalizeBitrixDeal(bitrixId, item, {
        clientId,
        portalDomain,
        portalTimezone: reverseConfig.portalTimezone,
        counterparty,
      }),
      requestId,
      lockToken,
      { actorUserId: requireActorUserId(reverseConfig.actorUserId) },
    );
    if (result.requestId !== null) {
      await this.reconcileRequestPayments(
        bitrixId,
        result.requestId,
        requestId,
        lockToken,
      );
    } else if (result.erpOrderId !== null) {
      await this.reconcileMappedOrderPayments(
        bitrixId,
        Number(result.erpOrderId),
        requestId,
        lockToken,
      );
    }
  }

  private async reconcileRequestPayments(
    dealId: string,
    requestId: number,
    auditRequestId: string,
    lockToken: string,
  ): Promise<void> {
    const payments = await this.loadManualPayments(dealId);
    await this.repository.replaceRequestPaymentSnapshots(
      requestId,
      payments,
      auditRequestId,
      lockToken,
    );
  }

  private async reconcileMappedOrderPayments(
    dealId: string,
    orderId: number,
    auditRequestId: string,
    lockToken?: string,
  ): Promise<void> {
    const payments = await this.loadManualPayments(dealId);
    await this.repository.replaceMappedOrderPaymentSnapshots(
      orderId,
      payments,
      auditRequestId,
      lockToken,
      dealId,
    );
  }

  private async loadManualPayments(
    dealId: string,
  ) {
    const paymentIds = await this.bitrix.listDealPaymentIds(dealId);
    const payments = [];
    for (const paymentId of paymentIds) {
      const payment = await this.bitrix.getPayment(paymentId);
      if (paymentIsErpOrigin(payment)) continue;
      payments.push(normalizeBitrixPayment(paymentId, payment));
    }
    return payments;
  }
}

function requireActorUserId(value: number | null): number {
  if (!value) throw new Error('Bitrix24 reverse sync service actor is not configured');
  return value;
}

function entityTypeId(
  objectType: Bitrix24InboundEventRow['objectType'],
): number {
  if (objectType === 'contact') return BITRIX24_ENTITY_TYPE.contact;
  if (objectType === 'company') return BITRIX24_ENTITY_TYPE.company;
  return BITRIX24_ENTITY_TYPE.deal;
}

function originId(
  item: Record<string, unknown>,
  prefix: 'ORDER',
): string | null {
  if (String(item.originatorId ?? '') !== 'MEBELKZ_ERP') return null;
  const match = String(item.originId ?? '').match(new RegExp(`^${prefix}_([1-9][0-9]*)$`));
  return match?.[1] ?? null;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
      .slice(0, 1000);
  }
  return 'Bitrix24 reverse processing failed';
}
