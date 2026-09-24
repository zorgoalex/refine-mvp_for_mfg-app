import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { DAILY_DIGEST_ORDER_READER, DAILY_DIGEST_RENDERER, type DailyDigestOrderReader, type DailyDigestRenderer, type DailyDigestRuntime, type DailyDigestSchedule, type DailyDigestSettings, type DailyDigestSettingsEnvelope, type DailyDigestSettingsInput, type DailyDigestPreview, type DailyDigestRunDetail, type DailyDigestRunState } from './daily-digest.types';
import type { DailyDigestSnapshot, DailyDigestRenderedPage } from './daily-digest-snapshot.types';
import { DailyDigestFileStore } from './daily-digest-file-store';
import { DailyDigestRepository, dailyDigestRequestDigest } from './daily-digest.repository';
import { WhatsAppRuntimeConfigService } from './whatsapp-runtime-config.service';
import { WhatsAppTechnicalLogService } from './whatsapp-technical-log.service';
import { WahaClient } from './waha.client';

const MAX_ORDERS = 500;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
// Leave a bounded cleanup margin so periodic deletion completes before the
// approved 24-hour maximum even when a sweep is delayed or briefly contended.
const IMAGE_TTL_MS = 24 * 60 * 60_000 - 10 * 60_000;

@Injectable()
export class DailyDigestService implements OnModuleInit {
  private cleaning = false;
  private cleanupReady = false;

  constructor(
    @Inject(DailyDigestRepository) private readonly repository: DailyDigestRepository,
    @Inject(DailyDigestFileStore) private readonly store: DailyDigestFileStore,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
    @Inject(WahaClient) private readonly waha: WahaClient,
    @Inject(DAILY_DIGEST_ORDER_READER) private readonly reader: DailyDigestOrderReader,
    @Inject(DAILY_DIGEST_RENDERER) private readonly renderer: DailyDigestRenderer,
    @Optional() @Inject(WhatsAppTechnicalLogService) private readonly technicalLogs?: WhatsAppTechnicalLogService,
  ) {}

  async onModuleInit() {
    // Digest storage is optional. Keep the ERP available, while image-backed
    // operations fail closed until this initial cleanup succeeds.
    await this.cleanupImages();
  }

  async settings(): Promise<DailyDigestSettingsEnvelope> {
    return this.envelope(await this.repository.getSettings());
  }

  async updateSettings(input: DailyDigestSettingsInput, actor: CurrentUser, requestId: string) {
    return this.envelope(await this.repository.updateSettings(input, actor, requestId));
  }

  private async envelope(settings: DailyDigestSettings): Promise<DailyDigestSettingsEnvelope> {
    // Read-only: a saved response may explain the frozen schedule, but never
    // plans one. A pre-184 schema degrades to null while real failures surface.
    const todaySchedule = await this.repository.getSchedule(businessDate()).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && (error as {code:string}).code === '42P01') return null;
      throw error;
    });
    return { settings, runtime: this.runtime(), todaySchedule };
  }

  async preview(): Promise<DailyDigestPreview> {
    const date = businessDate();
    return this.withRenderLease(async assertOwned => {
      const settings = await this.repository.getSettings();
      const snapshot = { ...(await this.readSnapshot(date)), cardsPerMessage: settings.cardsPerMessage };
      const rendered = snapshot.orders.length ? await this.renderChecked(snapshot) : [];
      await assertOwned();
      return { businessDate: date, orderCount: snapshot.orders.length, totalArea: snapshot.totalArea,
        pages: rendered.map(page => ({ pageIndex: page.pageIndex, orderIds: page.orderIds, imageDataUrl: `data:image/png;base64,${page.png.toString('base64')}` })), empty: snapshot.orders.length === 0 };
    });
  }

  async createManual(input: { settingsVersion: number; idempotencyKey: string; confirmed: true }, actor: CurrentUser, requestId: string): Promise<DailyDigestRunDetail> {
    const requestDigest = dailyDigestRequestDigest({kind:'manual',settingsVersion:input.settingsVersion,actorId:actor.id});
    const old = await this.repository.findByIdempotency(input.idempotencyKey,requestDigest);
    if (old) return old;
    if (!this.cleanupReady) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE', 'Хранилище рассылки временно недоступно');
    const date = businessDate();
    return this.withRenderLease(async assertRenderOwned => {
      // The optimistic lookup above is only a fast path. A prior request may
      // have committed while this request waited for the distributed render
      // lease, so resolve idempotency again before reading, rendering or writing.
      const committed = await this.repository.findByIdempotency(input.idempotencyKey, requestDigest);
      if (committed) return committed;
      const runtime = this.runtime();
      if (!runtime.relayAvailable) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_RUNTIME_UNAVAILABLE', runtime.unavailableReason ?? 'WhatsApp relay is unavailable');
      const settings = await this.repository.getSettings();
      if (settings.version !== input.settingsVersion) throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_VERSION_CONFLICT', 'Настройки изменились; обновите страницу');
      if (!settings.groupChatId) throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_DESTINATION_REQUIRED', 'Укажите группу WhatsApp перед отправкой');
      const snapshot = { ...(await this.readSnapshot(date)), cardsPerMessage: settings.cardsPerMessage };
      const renderedAt = Date.now();
      const rendered = snapshot.orders.length ? await this.renderChecked(snapshot) : [];
      const runId = randomUUID();
      const expiresAt = new Date(renderedAt + IMAGE_TTL_MS);
      const state: DailyDigestRunState = snapshot.orders.length ? 'queued' : 'empty';
      return this.store.withStoreLock(async assertStoreOwned => {
        let files: Awaited<ReturnType<DailyDigestFileStore['writePages']>> = [];
        let persistenceAttempted = false;
        try {
          files = await this.store.writePages(rendered, expiresAt, assertStoreOwned);
          const storedPages = rendered.map((page, index) => ({ ...files[index], pageIndex: page.pageIndex, orderIds: page.orderIds }));
          await assertRenderOwned();
          await assertStoreOwned();
          persistenceAttempted = true;
          const result = await this.repository.createRun({
            runId, businessDate: date, kind: 'manual', idempotencyKey: input.idempotencyKey,
            settingsVersion: settings.version, destinationChatId: settings.groupChatId!, catchUpPolicy: settings.catchUpPolicy,
            deadlineAt: expiresAt, partialPolicy: settings.partialPolicy, snapshot,
            orderCount: snapshot.orders.length, totalArea: snapshot.totalArea, state, actor, requestId, imageExpiresAt: rendered.length ? expiresAt : null, requestDigest,
          }, storedPages, assertStoreOwned);
          await assertStoreOwned();
          return result;
        } catch (error) {
          if (!persistenceAttempted) for (const file of files) await this.store.remove(file.fileKey, assertStoreOwned).catch(() => undefined);
          throw error;
        }
      }).then(value => {
        if (!value) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_STORE_BUSY', 'Хранилище рассылки занято; повторите запрос');
        return value;
      });
    });
  }

  async retry(runId: string, input: { mode: 'remaining'|'all'; idempotencyKey: string; duplicateRiskConfirmed: boolean }, actor: CurrentUser, requestId: string) {
    if (!this.runtime().relayAvailable) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_RUNTIME_UNAVAILABLE', 'WhatsApp relay is unavailable');
    const response = await this.repository.createRetry(runId, { ...input, actor, requestId, runId: randomUUID() });
    return response;
  }

  listRuns() { return this.repository.listRuns(); }
  run(runId: string) { return this.repository.getRun(runId); }

  async image(runId: string, pageIndex: number) {
    if (!this.cleanupReady) throw new ApiError(503,'WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE','Хранилище рассылки временно недоступно');
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) throw new ApiError(422,'VALIDATION_ERROR','Некорректный номер страницы');
    const metadata = await this.repository.getPageImageMetadata(runId,pageIndex);
    const stored = await this.store.withStoreLock(assertOwned => this.store.readImage(metadata.fileKey,metadata.sha256,metadata.expiresAt,assertOwned));
    if (!stored) throw new ApiError(503,'WHATSAPP_DAILY_DIGEST_STORE_BUSY','Хранилище рассылки занято');
    return stored;
  }

  async tick(now = new Date()) {
    // Planning is a pure-DB step that runs before the provider/store gates so
    // a relay or filesystem outage cannot postpone (and later redraw) the daily
    // chosen minute. Today's frozen schedule also drives any timing/catch-up
    // interpretation below; next-day changes apply to tomorrow's schedule.
    try {
      await this.planToday(now);
    } catch (error) {
      await this.logError('whatsapp.daily_digest.schedule','schedule.plan',error);
    }
    if (!this.cleanupReady || !this.runtime().relayAvailable) return;
    try {
      const settings = await this.repository.getSettings();
      if (settings.enabled) await this.scheduleIfDue(settings, now);
    } catch (error) {
      await this.logError('whatsapp.daily_digest.schedule','schedule.tick',error);
    }
    // Keep processing isolated from scheduling errors so already queued manual runs progress.
    try { await this.processPending(now); }
    catch (error) { await this.logError('whatsapp.daily_digest.process','delivery.tick',error); }
  }

  private async planToday(now: Date) {
    const settings = await this.repository.getSettings();
    if (!settings.enabled || !settings.groupChatId) return;
    await this.repository.getOrCreateSchedule(businessDate(now), drawScheduleOffset);
  }

  private async scheduleIfDue(settings: Awaited<ReturnType<DailyDigestRepository['getSettings']>>, now: Date) {
    const date = businessDate(now);
    if (!settings.groupChatId) return;
    const schedule = await this.repository.getOrCreateSchedule(date, drawScheduleOffset);
    // A committed automatic run (e.g. recorded before schedules existed) owns
    // the date; never plan or send a second one behind it.
    if (!schedule) return;
    const timing = scheduleTiming(schedule);
    const windowState = automaticWindowState(timing, now);
    if (windowState === 'before') return;
    if (windowState === 'missed') {
      await this.recordAutomaticWithoutImages(date, { ...settings, catchUpPolicy: schedule.catchUpPolicy }, 'skipped', 'MISSED_WINDOW', now);
      return;
    }
    if (await this.repository.hasAutomaticRun(date)) return;
    const dateDeadline = automaticDeadline(timing, date);
    await this.withRenderLease(async assertRenderOwned => {
      const snapshot = { ...(await this.readSnapshot(date)), cardsPerMessage: settings.cardsPerMessage };
      if (!snapshot.orders.length) {
        await this.recordAutomaticWithoutImages(date,{ ...settings, catchUpPolicy: schedule.catchUpPolicy },'empty','NO_ORDERS',now,snapshot);
        return;
      }
      const renderedAt = Date.now();
      const rendered = await this.renderChecked(snapshot);
      const expiresAt = new Date(renderedAt + IMAGE_TTL_MS);
      const runId = randomUUID();
      const key = randomUUID();
      const stored = await this.store.withStoreLock(async assertStoreOwned => {
        const files = await this.store.writePages(rendered,expiresAt,assertStoreOwned);
        const pages = rendered.map((page,index)=>({...files[index],pageIndex:page.pageIndex,orderIds:page.orderIds}));
        let persistenceAttempted = false;
        try {
          await assertRenderOwned();
          await assertStoreOwned();
          persistenceAttempted = true;
          const run = await this.repository.createRun({runId,businessDate:date,kind:'auto',idempotencyKey:key,settingsVersion:settings.version,
            destinationChatId:settings.groupChatId!,catchUpPolicy:schedule.catchUpPolicy,deadlineAt:dateDeadline,partialPolicy:settings.partialPolicy,
            snapshot,orderCount:snapshot.orders.length,totalArea:snapshot.totalArea,state:'queued',imageExpiresAt:expiresAt},pages,assertStoreOwned);
          await assertStoreOwned();
          return run;
        } catch (error) {
          if (!persistenceAttempted) for (const file of files) await this.store.remove(file.fileKey,assertStoreOwned).catch(()=>undefined);
          throw error;
        }
      });
      if (!stored) throw new ApiError(503,'WHATSAPP_DAILY_DIGEST_STORE_BUSY','Хранилище рассылки занято');
    });
  }

  private async recordAutomaticWithoutImages(date: string, settings: Awaited<ReturnType<DailyDigestRepository['getSettings']>>, state: 'empty'|'skipped', reason: string, now: Date, snapshot?: DailyDigestSnapshot) {
    try {
      await this.repository.createRun({runId:randomUUID(),businessDate:date,kind:'auto',idempotencyKey:randomUUID(),settingsVersion:settings.version,
        destinationChatId:settings.groupChatId!,catchUpPolicy:settings.catchUpPolicy,deadlineAt:null,partialPolicy:settings.partialPolicy,
        snapshot: snapshot ?? null,orderCount:snapshot?.orders.length ?? 0,totalArea:snapshot?.totalArea ?? 0,state,reason,imageExpiresAt:null});
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'WHATSAPP_DAILY_DIGEST_DUPLICATE')) throw error;
    }
    void now;
  }

  private async processPending(now = new Date()) {
    const outcome = await this.database.withAdvisoryLock('whatsapp-daily-digest-processing',async assertOwned => {
      await this.repository.markStaleIntentsUnknown(this.runtimeConfig.getConfig().relayStaleLockMs,now);
      const runIds = await this.repository.listQueuedRunIds();
      for (const runId of runIds) {
        const pages = await this.repository.pagesForWorker(runId);
        for (const page of pages) {
          if (page.state === 'sent') continue;
          // Strict page order: a later page can never pass an unresolved earlier page.
          if (page.state !== 'pending') {
            if (page.state === 'unknown') await this.repository.markRun(runId,'unknown','PROVIDER_OUTCOME_UNKNOWN');
            break;
          }
          if (page.next_attempt_at && page.next_attempt_at.getTime() > now.getTime()) break;
          await assertOwned();
          let image;
          try {
            const metadata = await this.repository.getPageImageMetadata(runId,page.page_index);
            image = await this.store.withStoreLock(lockOwned => this.store.readImage(metadata.fileKey,metadata.sha256,metadata.expiresAt,lockOwned));
            if (!image) {
              await this.failPreflight(runId,page.page_index,'WHATSAPP_DAILY_DIGEST_STORE_BUSY');
              break;
            }
          } catch (error) {
            const errorCode = error instanceof ApiError?error.code:'IMAGE_UNAVAILABLE';
            await this.failPreflight(runId,page.page_index,errorCode);
            await this.logError('whatsapp.daily_digest.image_unavailable','page.read',error,{runId,pageIndex:page.page_index});
            break;
          }
          const intent = await this.repository.createSendIntent(runId,page.page_index,this.runtimeConfig.getConfig().enabled);
          if (!intent) break;
          await assertOwned();
          try {
            const sent = await this.waha.sendImage(intent.destinationChatId,image.bytes,`orders-${page.page_index}.png`,page.page_index===1?'Заказы на сегодня':'');
            if (!sent.messageId) {
              await this.repository.settlePage(runId,page.page_index,intent.token,{state:'unknown',errorCode:'PROVIDER_ACK_MISSING_ID'});
              break;
            }
            const settled = await this.repository.settlePage(runId,page.page_index,intent.token,{state:'sent',providerMessageId:sent.messageId});
            if (!settled) break;
            page.state = 'sent';
          } catch (error) {
            await this.repository.settlePage(runId,page.page_index,intent.token,{state:'unknown',errorCode:error instanceof ApiError?error.code:'WAHA_UNCERTAIN'});
            break;
          }
        }
      }
      return true;
    });
    if (!outcome) return;
  }

  async cleanupImages(now = new Date()) {
    if (this.cleaning) return this.cleanupReady;
    this.cleaning = true;
    try {
      const outcome = await this.store.withStoreLock(async assertOwned => {
        const refs = await this.repository.expireImagesAndPruneSnapshots(now);
        await assertOwned();
        return this.store.sweep(refs.referenced,refs.expiredKeys,assertOwned,now);
      });
      this.cleanupReady = outcome !== null;
      return this.cleanupReady;
    } catch (error) {
      this.cleanupReady = false;
      await this.logError('whatsapp.daily_digest.cleanup','retention.cleanup',error);
      return false;
    } finally { this.cleaning = false; }
  }

  private async failPreflight(runId: string, pageIndex: number, errorCode: string) {
    await this.repository.failPendingPageBeforeIntent(runId,pageIndex,errorCode);
    await this.repository.createPolicyRetryAfterPreflightFailure(runId);
  }

  private async logError(eventCode: string, operation: string, error: unknown, details?: Record<string,string|number|boolean|null>) {
    await this.technicalLogs?.record({component:'backend',level:'error',eventCode,outcome:'failed',operation,errorCode:error instanceof ApiError?error.code:'DAILY_DIGEST_FAILED',details});
  }

  private async readSnapshot(date: string): Promise<DailyDigestSnapshot> {
    const snapshot = await this.reader.read(date);
    if (snapshot.businessDate !== date || !Array.isArray(snapshot.orders) || snapshot.orders.length > MAX_ORDERS || !Number.isFinite(snapshot.totalArea) || snapshot.totalArea < 0) {
      throw new ApiError(422,'WHATSAPP_DAILY_DIGEST_SNAPSHOT_INVALID','Заказы не удалось безопасно подготовить для рассылки');
    }
    return snapshot;
  }

  private async renderChecked(snapshot: DailyDigestSnapshot): Promise<DailyDigestRenderedPage[]> {
    if (snapshot.cardsPerMessage !== 1 && snapshot.cardsPerMessage !== 2) {
      throw new ApiError(422,'WHATSAPP_DAILY_DIGEST_SNAPSHOT_INVALID','Заказы не удалось безопасно подготовить для рассылки');
    }
    const pages = await this.renderer.render(snapshot);
    const expectedCount = Math.ceil(snapshot.orders.length / snapshot.cardsPerMessage);
    const totalBytes = pages.reduce((sum,page)=>sum+page.png.byteLength,0);
    if (pages.length !== expectedCount || pages.some((page,index)=>page.pageIndex!==index+1 || page.orderIds.length<1 || page.orderIds.length>snapshot.cardsPerMessage || page.png.byteLength>MAX_PAGE_BYTES) || totalBytes>MAX_RUN_BYTES) {
      throw new ApiError(413,'WHATSAPP_DAILY_DIGEST_RENDER_LIMIT','Изображения рассылки не прошли проверку размера или состава');
    }
    const ids = pages.flatMap(page=>page.orderIds);
    const expected = snapshot.orders.map(order=>order.orderId);
    if (ids.length!==expected.length || ids.some((id,index)=>id!==expected[index])) throw new ApiError(422,'WHATSAPP_DAILY_DIGEST_RENDER_INVALID','Страницы рассылки не совпадают со снимком заказов');
    return pages;
  }

  private runtime(): DailyDigestRuntime {
    const config = this.runtimeConfig.getConfig();
    const relayAvailable = config.enabled && config.relayOwner === 'in_process';
    const unavailableReason = relayAvailable ? null : !config.enabled ? 'whatsapp_disabled'
      : config.relayOwner === 'in_process' ? 'relay_unavailable' : 'relay_owner_mismatch';
    return {enabled:config.enabled,relayAvailable,unavailableReason};
  }

  private async withRenderLease<T>(handler:(assertOwned:()=>Promise<void>)=>Promise<T>):Promise<T> {
    const locked = await this.database.withAdvisoryLock('whatsapp-daily-digest-render',handler);
    if (locked === null) throw new ApiError(503,'WHATSAPP_DAILY_DIGEST_RENDER_BUSY','Подготовка рассылки уже выполняется');
    return locked;
  }
}

export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function businessTime(now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
}
export function businessClock(now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
}
export function automaticWindowState(settings: Pick<Awaited<ReturnType<DailyDigestRepository['getSettings']>>, 'sendTime'|'catchUpPolicy'|'catchUpDeadline'>, now: Date): 'before'|'open'|'missed' {
  const clock = businessClock(now);
  if (clock < `${settings.sendTime}:00`) return 'before';
  const lastSecond = settings.catchUpPolicy === 'end_of_day' ? '23:59:59'
    : settings.catchUpPolicy === 'until_deadline' ? `${settings.catchUpDeadline}:59` : `${settings.sendTime}:59`;
  return clock <= lastSecond ? 'open' : 'missed';
}
export function automaticDeadline(settings: Pick<Awaited<ReturnType<DailyDigestRepository['getSettings']>>, 'sendTime'|'catchUpPolicy'|'catchUpDeadline'>, date: string): Date {
  const time = settings.catchUpPolicy === 'end_of_day' ? '23:59:59'
    : settings.catchUpPolicy === 'until_deadline' ? `${settings.catchUpDeadline}:59` : `${settings.sendTime}:59`;
  return zonedDateTime(date,time);
}
// The frozen schedule replaces configured timing with the day's chosen minute
// while keeping the stored catch-up policy; everything else stays current.
export function scheduleTiming(schedule: Pick<DailyDigestSchedule,'scheduledAt'|'catchUpPolicy'|'catchUpDeadline'>): Pick<DailyDigestSettings,'sendTime'|'catchUpPolicy'|'catchUpDeadline'> {
  return {sendTime:businessTime(new Date(schedule.scheduledAt)),catchUpPolicy:schedule.catchUpPolicy,catchUpDeadline:schedule.catchUpDeadline};
}
function drawScheduleOffset(durationMinutes: number): number {
  return randomInt(durationMinutes);
}
function zonedDateTime(date: string,time: string) {
  const [hour,minute,second='0'] = time.split(':');
  return new Date(`${date}T${hour}:${minute}:${second}.999+05:00`);
}
