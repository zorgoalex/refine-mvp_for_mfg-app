import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { DailyDigestFileStore } from '../daily-digest-file-store';
import { DailyDigestRepository } from '../daily-digest.repository';
import type { DailyDigestRenderedPage, DailyDigestSnapshot } from '../daily-digest-snapshot.types';
import { DAILY_DIGEST_ORDER_READER, DAILY_DIGEST_RENDERER, type DailyDigestOrderReader, type DailyDigestRenderer } from '../daily-digest.types';
import { WahaClient } from '../waha.client';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { WhatsAppTechnicalLogService } from '../whatsapp-technical-log.service';
import { renderCaption } from './broadcast-caption';
import { BroadcastFileStore } from './broadcast-file-store';
import { BroadcastRepository, type PreparationContext } from './broadcast.repository';
import type { BroadcastRuntime, BroadcastStoredImage } from './broadcast.types';

const MAX_ORDERS = 500;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
// Bounded cleanup margin keeps physical deletion inside the approved 24-hour maximum.
export const BROADCAST_IMAGE_TTL_MS = 24 * 60 * 60_000 - 10 * 60_000;
/** Budgets of one delivery/preparation iteration (plan §6.2). */
const DELIVERY_BUDGET = 20;
const PREPARATION_BUDGET = 2;

/**
 * Background work of the broadcasts. Fixation, delivery/preparation and cleanup run on
 * separate timers with separate busy flags, so a long delivery iteration never delays
 * fixing the next dispatch slot.
 */
@Injectable()
export class BroadcastWorker implements OnModuleInit {
  private fixing = false;
  private working = false;
  private cleaning = false;
  private cleanupReady = false;

  constructor(
    @Inject(BroadcastRepository) private readonly repository: BroadcastRepository,
    @Inject(BroadcastFileStore) private readonly store: BroadcastFileStore,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
    @Inject(WahaClient) private readonly waha: WahaClient,
    @Inject(DAILY_DIGEST_ORDER_READER) private readonly reader: DailyDigestOrderReader,
    @Inject(DAILY_DIGEST_RENDERER) private readonly renderer: DailyDigestRenderer,
    @Inject(DailyDigestRepository) private readonly legacyRepository: DailyDigestRepository,
    @Inject(DailyDigestFileStore) private readonly legacyStore: DailyDigestFileStore,
    @Optional() @Inject(WhatsAppTechnicalLogService) private readonly technicalLogs?: WhatsAppTechnicalLogService,
  ) {}

  async onModuleInit() {
    // Image storage is optional: the ERP stays available and image-backed operations
    // fail closed until the first cleanup succeeds.
    await this.cleanup();
    await this.repository.legacyQueueUnfinished().then(async (unfinished) => {
      if (unfinished) await this.log('warn', 'whatsapp.broadcast.legacy_queue', 'startup.legacy_queue', 'LEGACY_DIGEST_QUEUE_UNFINISHED');
    }).catch(() => undefined);
  }

  get storeReady(): boolean {
    return this.cleanupReady;
  }

  runtime(): BroadcastRuntime {
    const config = this.runtimeConfig.getConfig();
    const relayAvailable = config.enabled && config.relayOwner === 'in_process';
    const unavailableReason = relayAvailable ? null : !config.enabled ? 'whatsapp_disabled'
      : config.relayOwner === 'in_process' ? 'relay_unavailable' : 'relay_owner_mismatch';
    return { enabled: config.enabled, relayAvailable, unavailableReason };
  }

  /** Fixation loop: short DB transactions only, independent of provider and store state. */
  async fixDue(clock: () => Date = () => new Date()) {
    if (this.fixing) return;
    this.fixing = true;
    try {
      for (const id of await this.repository.listActiveBroadcastIds()) {
        try {
          await this.repository.fixAutomaticRun(id, clock, (duration) => randomInt(duration));
        } catch (error) {
          await this.logError('whatsapp.broadcast.fixation', 'schedule.fix', error, { broadcastId: id });
        }
      }
    } catch (error) {
      await this.logError('whatsapp.broadcast.fixation', 'schedule.list', error);
    } finally {
      this.fixing = false;
    }
  }

  /** Delivery first, then at most two preparations per iteration. */
  async work(now = new Date()) {
    if (this.working) return;
    this.working = true;
    try {
      if (!this.cleanupReady) return;
      if (this.runtime().relayAvailable) {
        try { await this.deliver(now); } catch (error) { await this.logError('whatsapp.broadcast.delivery', 'delivery.iteration', error); }
      }
      try { await this.prepareDue(now); } catch (error) { await this.logError('whatsapp.broadcast.prepare', 'prepare.iteration', error); }
    } finally {
      this.working = false;
    }
  }

  async prepareDue(now = new Date()) {
    for (const runId of await this.repository.listPreparingRuns(PREPARATION_BUDGET)) {
      const context = await this.repository.getPreparationContext(runId);
      if (!context) continue;
      if (context.deadlineAt && context.deadlineAt.getTime() <= now.getTime()) {
        await this.repository.failPreparation(runId, 'BROADCAST_PREPARATION_LATE');
        continue;
      }
      try {
        await this.prepare(context, now);
      } catch (error) {
        if (error instanceof ApiError && ['BROADCAST_RENDER_BUSY', 'BROADCAST_STORE_BUSY'].includes(error.code)) continue;
        const code = error instanceof ApiError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'BROADCAST_PREPARATION_FAILED';
        await this.repository.failPreparation(runId, code);
        await this.logError('whatsapp.broadcast.prepare', 'prepare.run', error, { runId });
      }
    }
  }

  private async prepare(context: PreparationContext, now: Date) {
    await this.withRenderLease(async (assertRenderOwned) => {
      const snapshot = { ...(await this.readSnapshot(context.targetDate)), cardsPerMessage: context.cardsPerMessage };
      const caption = renderCaption(context.captionTemplate, { now, targetDate: context.targetDate });
      const rendered = snapshot.orders.length ? await this.renderChecked(snapshot) : [];
      const expiresAt = new Date(Date.now() + BROADCAST_IMAGE_TTL_MS);
      const stored = await this.store.withStoreLock(async (assertStoreOwned) => {
        const files = await this.store.writePages(rendered, expiresAt, assertStoreOwned);
        let persisted = false;
        try {
          await assertRenderOwned();
          await assertStoreOwned();
          const outcome = await this.repository.completePreparation(context, {
            snapshot, images: toImages(rendered, files, caption), imageExpiresAt: rendered.length ? expiresAt : null,
          });
          persisted = outcome === 'queued';
          return outcome;
        } finally {
          if (!persisted) for (const file of files) await this.store.remove(file.fileKey, assertStoreOwned).catch(() => undefined);
        }
      });
      if (stored === null) throw new ApiError(503, 'BROADCAST_STORE_BUSY', 'Хранилище рассылок занято');
    });
  }

  private async deliver(now: Date) {
    await this.database.withAdvisoryLock('whatsapp-broadcast-processing', async (assertOwned) => {
      await this.repository.markStaleIntentsUnknown(this.runtimeConfig.getConfig().relayStaleLockMs, now);
      let budget = DELIVERY_BUDGET;
      let progressed = true;
      while (budget > 0 && progressed) {
        progressed = false;
        for (const runId of await this.repository.listDeliverableRuns()) {
          if (budget <= 0) break;
          await assertOwned();
          if (await this.deliverNext(runId, now)) {
            budget -= 1;
            progressed = true;
          }
        }
      }
    });
  }

  /** Send the next message of one run in strict order; returns true when an attempt was made. */
  private async deliverNext(runId: string, now: Date): Promise<boolean> {
    const messages = await this.repository.messagesForWorker(runId);
    const next = messages.find((message) => message.state !== 'sent');
    if (!next) return false;
    if (next.state !== 'pending') {
      if (next.state === 'unknown') await this.repository.markRun(runId, 'unknown', 'PROVIDER_OUTCOME_UNKNOWN');
      return false;
    }
    if (next.next_attempt_at.getTime() > now.getTime()) return false;
    let bytes: Buffer | null = null;
    if (next.message_kind === 'image') {
      try {
        const metadata = await this.repository.getImageMetadata(runId, next.delivery_seq);
        const image = await this.store.withStoreLock((owned) => this.store.readImage(metadata.fileKey, metadata.sha256, metadata.expiresAt, owned));
        if (!image) {
          await this.failPreflight(runId, next.delivery_seq, 'BROADCAST_STORE_BUSY');
          return false;
        }
        bytes = image.bytes;
      } catch (error) {
        await this.failPreflight(runId, next.delivery_seq, error instanceof ApiError ? error.code : 'IMAGE_UNAVAILABLE');
        await this.logError('whatsapp.broadcast.image_unavailable', 'message.read', error, { runId, deliverySeq: next.delivery_seq });
        return false;
      }
    }
    const intent = await this.repository.createSendIntent(runId, next.delivery_seq, this.runtimeConfig.getConfig().enabled);
    if (!intent) return false;
    try {
      const sent = intent.kind === 'image'
        ? await this.waha.sendImage(intent.destinationChatId, bytes as Buffer, `orders-${next.delivery_seq}.png`, intent.caption ?? '')
        : await this.waha.sendText(intent.destinationChatId, intent.textBody ?? '');
      await this.repository.settleMessage(runId, next.delivery_seq, intent.token, sent.messageId
        ? { state: 'sent', providerMessageId: sent.messageId }
        : { state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID' });
    } catch (error) {
      await this.repository.settleMessage(runId, next.delivery_seq, intent.token,
        { state: 'unknown', errorCode: error instanceof ApiError ? error.code : 'WAHA_UNCERTAIN' });
    }
    return true;
  }

  private async failPreflight(runId: string, seq: number, errorCode: string) {
    await this.repository.failPendingBeforeIntent(runId, seq, errorCode);
    await this.repository.createPolicyRetryAfterPreflightFailure(runId);
  }

  /** Retention of the broadcasts and, separately, of the legacy digest tables (plan §2.2). */
  async cleanup(now = new Date()) {
    if (this.cleaning) return this.cleanupReady;
    this.cleaning = true;
    try {
      const outcome = await this.store.withStoreLock(async (assertOwned) => {
        const refs = await this.repository.expireAndPrune(now);
        await assertOwned();
        return this.store.sweep(refs.referenced, refs.expiredKeys, assertOwned, now);
      });
      this.cleanupReady = outcome !== null;
    } catch (error) {
      this.cleanupReady = false;
      await this.logError('whatsapp.broadcast.cleanup', 'retention.cleanup', error);
    }
    try {
      await this.legacyStore.withStoreLock(async (assertOwned) => {
        const refs = await this.legacyRepository.expireImagesAndPruneSnapshots(now);
        await assertOwned();
        return this.legacyStore.sweep(refs.referenced, refs.expiredKeys, assertOwned, now);
      });
    } catch (error) {
      await this.logError('whatsapp.daily_digest.cleanup', 'legacy.retention', error);
    } finally {
      this.cleaning = false;
    }
    return this.cleanupReady;
  }

  async readSnapshot(targetDate: string): Promise<DailyDigestSnapshot> {
    const snapshot = await this.reader.read(targetDate);
    if (snapshot.businessDate !== targetDate || !Array.isArray(snapshot.orders) || snapshot.orders.length > MAX_ORDERS
      || !Number.isFinite(snapshot.totalArea) || snapshot.totalArea < 0) {
      throw new ApiError(422, 'BROADCAST_SNAPSHOT_INVALID', 'Заказы не удалось безопасно подготовить для рассылки');
    }
    return snapshot;
  }

  async renderChecked(snapshot: DailyDigestSnapshot): Promise<DailyDigestRenderedPage[]> {
    if (snapshot.cardsPerMessage !== 1 && snapshot.cardsPerMessage !== 2) {
      throw new ApiError(422, 'BROADCAST_SNAPSHOT_INVALID', 'Заказы не удалось безопасно подготовить для рассылки');
    }
    const pages = await this.renderer.render(snapshot);
    const expectedCount = Math.ceil(snapshot.orders.length / snapshot.cardsPerMessage);
    const totalBytes = pages.reduce((sum, page) => sum + page.png.byteLength, 0);
    if (pages.length !== expectedCount || totalBytes > MAX_RUN_BYTES || pages.some((page, index) => page.pageIndex !== index + 1
      || page.orderIds.length < 1 || page.orderIds.length > snapshot.cardsPerMessage || page.png.byteLength > MAX_PAGE_BYTES)) {
      throw new ApiError(413, 'BROADCAST_RENDER_LIMIT', 'Изображения рассылки не прошли проверку размера или состава');
    }
    const ids = pages.flatMap((page) => page.orderIds);
    const expected = snapshot.orders.map((order) => order.orderId);
    if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
      throw new ApiError(422, 'BROADCAST_RENDER_INVALID', 'Страницы рассылки не совпадают со снимком заказов');
    }
    return pages;
  }

  async withRenderLease<T>(handler: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
    const locked = await this.database.withAdvisoryLock('whatsapp-broadcast-render', handler);
    if (locked === null) throw new ApiError(503, 'BROADCAST_RENDER_BUSY', 'Подготовка рассылки уже выполняется');
    return locked;
  }

  private async logError(eventCode: string, operation: string, error: unknown, details?: Record<string, string | number | boolean | null>) {
    await this.log('error', eventCode, operation, error instanceof ApiError ? error.code : 'BROADCAST_FAILED', details);
  }

  private async log(level: 'warn' | 'error', eventCode: string, operation: string, errorCode: string, details?: Record<string, string | number | boolean | null>) {
    await this.technicalLogs?.record({ component: 'backend', level, eventCode, outcome: 'failed', operation, errorCode, details }).catch(() => undefined);
  }
}

export function toImages(rendered: DailyDigestRenderedPage[], files: Array<{ fileKey: string; sha256: string; sizeBytes: number; expiresAt: Date }>,
  caption: string): BroadcastStoredImage[] {
  return rendered.map((page, index) => ({
    imageIndex: page.pageIndex, orderIds: page.orderIds, fileKey: files[index].fileKey, sha256: files[index].sha256,
    sizeBytes: files[index].sizeBytes, expiresAt: files[index].expiresAt, caption: index === 0 && caption ? caption : null,
  }));
}
