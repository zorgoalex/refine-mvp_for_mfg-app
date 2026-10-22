import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { WahaClient } from '../waha.client';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { WhatsAppService } from '../whatsapp.service';
import { WhatsAppTechnicalLogService } from '../whatsapp-technical-log.service';
import { WhatsAppNotificationRepository, type DeliveryRow } from './whatsapp-notification.repository';
import { WHATSAPP_NOTIFICATION_LIMITS as LIMITS } from './whatsapp-notification.types';

/** WAHA refused the request itself (validation, unsupported): nothing was sent. Same list as the order sends. */
const DEFINITE_REJECTIONS = new Set([400, 404, 405, 415, 422, 501]);

/**
 * Delivery of WhatsApp notifications: one message per iteration, at most once.
 * Startup never fails and never calls WAHA: the new delivery epoch is one short SQL; when it fails, the worker
 * delivers nothing until this process has started its epoch (retried on every tick).
 */
@Injectable()
export class WhatsAppNotificationWorker implements OnModuleInit, OnModuleDestroy {
  clock: () => Date = () => new Date();
  /** The epoch this process started; null — not yet (nothing is delivered). */
  private epoch: number | null = null;
  private working = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(WhatsAppNotificationRepository) private readonly repository: WhatsAppNotificationRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
    @Inject(WahaClient) private readonly waha: WahaClient,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
    @Optional() @Inject(WhatsAppTechnicalLogService) private readonly technicalLogs?: WhatsAppTechnicalLogService,
  ) {}

  /** Awaited by Nest before the modules that depend on this one (the 1C monitor) start. */
  async onModuleInit() {
    await this.ensureEpoch();
    this.timers = [
      setInterval(() => void this.work().catch(() => undefined), 15_000),
      setInterval(() => void this.cleanup().catch(() => undefined), 60 * 60_000),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** The epoch of this process (null until started). */
  currentEpoch(): number | null {
    return this.epoch;
  }

  /** Starts the epoch once per process; never throws. */
  async ensureEpoch(): Promise<boolean> {
    if (this.epoch !== null) return true;
    try {
      this.epoch = await this.repository.startEpoch(this.clock());
      return true;
    } catch (error) {
      await this.log('whatsapp.notification.epoch', 'epoch.start', error instanceof ApiError ? error.code : 'WHATSAPP_NOTIFICATION_EPOCH_FAILED');
      return false;
    }
  }

  private deliverable(): boolean {
    const config = this.runtimeConfig.getConfig();
    return config.enabled && config.relayOwner === 'in_process';
  }

  async work() {
    if (this.working) return;
    this.working = true;
    try {
      if (!(await this.ensureEpoch())) return;
      const epoch = this.epoch as number;
      // Bookkeeping runs even when WhatsApp is off, so the consumer sees a final state instead of an endless «queued».
      await this.repository.cancelEarlierEpochs(epoch, this.clock());
      await this.repository.expireDue(this.clock());
      if (!this.deliverable()) return;
      await this.database.withAdvisoryLock('whatsapp-notification-delivery', async (assertOwned) => {
        // A process of an earlier epoch (a newer backend has started) does nothing more: the newer one delivers.
        if (!(await this.repository.isCurrentEpoch(epoch))) return;
        await this.repository.markStaleUnknown(this.runtimeConfig.getConfig().relayStaleLockMs, this.clock());
        // Paused: nothing reaches WAHA (no phone check, no group list) and nothing is finished for it.
        if (await this.repository.paused()) return;
        await assertOwned();
        const next = await this.repository.nextDue(this.clock(), epoch);
        if (next) await this.deliver(next, epoch, assertOwned);
      });
    } catch (error) {
      await this.log('whatsapp.notification.delivery', 'delivery.iteration', error instanceof ApiError ? error.code : 'WHATSAPP_NOTIFICATION_FAILED');
    } finally {
      this.working = false;
    }
  }

  private async deliver(row: DeliveryRow, epoch: number, assertOwned: () => Promise<void>) {
    const now = this.clock();
    if (row.expires_at.getTime() <= now.getTime()) {
      await this.repository.finishBeforeIntent(row.delivery_id, epoch, 'cancelled', 'expired', now);
      return;
    }
    try {
      if (row.recipient_kind === 'user') {
        // The phone is resolved once; the intent re-checks under locks that the contact and number are unchanged.
        if (!row.destination_chat_id) {
          if (!row.phone_normalized) {
            await this.repository.finishBeforeIntent(row.delivery_id, epoch, 'failed', 'PAYLOAD_MISSING', now);
            return;
          }
          const check = await this.waha.checkPhone(row.phone_normalized);
          if (!check.exists || !check.chatId) {
            await this.repository.finishBeforeIntent(row.delivery_id, epoch, 'failed', 'EMPLOYEE_NOT_ON_WHATSAPP', this.clock());
            return;
          }
          await this.repository.setDestination(row.delivery_id, epoch, check.chatId);
        }
      } else {
        // Before every attempt (a delivery may wait for the quota or the pause): the group must still be one of
        // the connected session's groups (the cached list of the settings screens).
        const groups = await this.whatsapp.listGroups(false, now.getTime());
        const group = groups.groups.find((item) => item.id === row.chat_id);
        if (!group || group.suspended || group.communityParent) {
          await this.repository.finishBeforeIntent(row.delivery_id, epoch, 'failed', 'CHAT_NOT_FOUND', this.clock());
          return;
        }
        if (!row.destination_chat_id) await this.repository.setDestination(row.delivery_id, epoch, group.id);
      }
    } catch (error) {
      await this.repository.postpone(row.delivery_id, epoch, new Date(this.clock().getTime() + LIMITS.retryMs),
        error instanceof ApiError ? error.code.slice(0, 64) : 'WAHA_UNAVAILABLE');
      return;
    }
    await assertOwned();
    const intent = await this.repository.createIntent(row.delivery_id, epoch, this.clock);
    if (!intent) return;
    try {
      const sent = await this.waha.sendText(intent.destinationChatId, intent.body);
      await this.repository.settle(intent.deliveryId, intent.token, sent.messageId
        ? { state: 'sent', providerMessageId: sent.messageId }
        : { state: 'unknown', reason: 'PROVIDER_ACK_MISSING_ID' }, this.clock());
    } catch (error) {
      await this.repository.settle(intent.deliveryId, intent.token, failure(error), this.clock());
    }
  }

  async cleanup() {
    try {
      // Batches of 500 until the backlog is done (bounded per pass).
      for (let batch = 0; batch < 20; batch += 1) {
        if ((await this.repository.purge(this.clock())) < 500) break;
      }
    } catch (error) {
      await this.log('whatsapp.notification.cleanup', 'retention.cleanup', error instanceof ApiError ? error.code : 'WHATSAPP_NOTIFICATION_CLEANUP_FAILED');
    }
  }

  private async log(eventCode: string, operation: string, errorCode: string) {
    await this.technicalLogs?.record({ component: 'backend', level: 'error', eventCode, outcome: 'failed', operation, errorCode }).catch(() => undefined);
  }
}

/** A definite rejection fails; anything else is unknown (never repeated). */
function failure(error: unknown): { state: 'failed' | 'unknown'; reason: string } {
  const status = error instanceof ApiError ? Number(error.details?.httpStatus) : NaN;
  const definite = error instanceof ApiError && error.code === 'WAHA_PROVIDER_ERROR' && DEFINITE_REJECTIONS.has(status);
  return definite ? { state: 'failed', reason: 'WAHA_REJECTED' }
    : { state: 'unknown', reason: error instanceof ApiError ? error.code.slice(0, 64) : 'WAHA_UNCERTAIN' };
}
