import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { DailyDigestRepository } from '../daily-digest.repository';
import { CAPTION_VARIABLES, renderCaption } from './broadcast-caption';
import { BroadcastFileStore } from './broadcast-file-store';
import { addDays, businessDate } from './broadcast-time';
import { BROADCAST_IMAGE_TTL_MS, BroadcastWorker, toImages } from './broadcast-worker.service';
import { BroadcastRepository, commandFingerprint } from './broadcast.repository';
import {
  BROADCAST_MAX_ACTIVE,
  type BroadcastEnvelope, type BroadcastInput, type BroadcastPreview, type BroadcastRunDetail, type BroadcastUpdateInput,
} from './broadcast.types';

@Injectable()
export class BroadcastService {
  constructor(
    @Inject(BroadcastRepository) private readonly repository: BroadcastRepository,
    @Inject(BroadcastWorker) private readonly worker: BroadcastWorker,
    @Inject(BroadcastFileStore) private readonly store: BroadcastFileStore,
    @Inject(DailyDigestRepository) private readonly legacyRepository: DailyDigestRepository,
  ) {}

  async list() {
    const [broadcasts, control] = await Promise.all([this.repository.listBroadcasts(), this.repository.getControl()]);
    return { broadcasts, control, runtime: this.worker.runtime(), limits: { maxActive: BROADCAST_MAX_ACTIVE } };
  }

  async get(id: number): Promise<BroadcastEnvelope> {
    const broadcast = await this.repository.getBroadcast(id);
    return { broadcast, todaySchedule: await this.repository.getSchedule(id, businessDate()), runtime: this.worker.runtime() };
  }

  async create(input: BroadcastInput, actor: CurrentUser, requestId: string) {
    const broadcast = await this.repository.createBroadcast(input, actor, requestId);
    return this.get(broadcast.id);
  }

  async update(id: number, input: BroadcastUpdateInput, actor: CurrentUser, requestId: string) {
    await this.repository.updateBroadcast(id, input, actor, requestId);
    return this.get(id);
  }

  async archive(id: number, version: number, actor: CurrentUser, requestId: string) {
    await this.repository.archiveBroadcast(id, version, actor, requestId);
    return this.get(id);
  }

  control() { return this.repository.getControl(); }
  setControl(version: number, paused: boolean, actor: CurrentUser, requestId: string) {
    return this.repository.setControl(version, paused, actor, requestId);
  }

  catalog() {
    return { captionVariables: CAPTION_VARIABLES.map((variable) => ({ ...variable })) };
  }

  legacyRuns() { return this.legacyRepository.listRuns(); }

  async preview(id: number): Promise<BroadcastPreview> {
    const broadcast = await this.repository.getBroadcast(id);
    const now = new Date();
    const date = businessDate(now);
    const targetDate = addDays(date, broadcast.orderDateOffsetDays);
    return this.worker.withRenderLease(async (assertOwned) => {
      const snapshot = { ...(await this.worker.readSnapshot(targetDate)), cardsPerMessage: broadcast.cardsPerMessage };
      const caption = renderCaption(broadcast.captionTemplate, { now, targetDate });
      const rendered = snapshot.orders.length ? await this.worker.renderChecked(snapshot) : [];
      await assertOwned();
      return {
        businessDate: date, targetDate, orderCount: snapshot.orders.length, totalArea: snapshot.totalArea, caption,
        pages: rendered.map((page) => ({ pageIndex: page.pageIndex, orderIds: page.orderIds, imageDataUrl: `data:image/png;base64,${page.png.toString('base64')}` })),
        empty: snapshot.orders.length === 0,
      };
    });
  }

  async createManual(id: number, input: { settingsVersion: number; idempotencyKey: string; confirmed: true }, actor: CurrentUser, requestId: string): Promise<BroadcastRunDetail> {
    const fingerprint = commandFingerprint({ kind: 'manual', broadcastId: id, settingsVersion: input.settingsVersion, actorId: actor.id, confirmed: input.confirmed });
    const replay = await this.repository.findCommand(id, input.idempotencyKey, fingerprint);
    if (replay) return this.repository.getRunDetail(String(replay.runId));
    if (!this.worker.storeReady) throw new ApiError(503, 'BROADCAST_STORE_UNAVAILABLE', 'Хранилище рассылок временно недоступно');
    const runtime = this.worker.runtime();
    if (!runtime.relayAvailable) throw new ApiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE', runtime.unavailableReason ?? 'WhatsApp relay is unavailable');
    const result = await this.worker.withRenderLease(async (assertRenderOwned) => {
      // Idempotency is resolved again under the lease and finally inside the write transaction.
      // A same-key attempt can only commit while holding this lease, so a refusal below is never
      // returned for a key that is already committed (it is replayed here instead).
      const committed = await this.repository.findCommand(id, input.idempotencyKey, fingerprint);
      if (committed) return { runId: String(committed.runId), replayed: true };
      const broadcast = await this.repository.getBroadcast(id);
      if (broadcast.archived) throw new ApiError(409, 'BROADCAST_ARCHIVED', 'Рассылка в архиве');
      if (broadcast.version !== input.settingsVersion) throw new ApiError(409, 'BROADCAST_VERSION_CONFLICT', 'Рассылка уже изменена; обновите страницу');
      if (!broadcast.groupChatId) throw new ApiError(409, 'BROADCAST_DESTINATION_REQUIRED', 'Укажите группу WhatsApp перед отправкой');
      const now = new Date();
      const date = businessDate(now);
      const targetDate = addDays(date, broadcast.orderDateOffsetDays);
      const snapshot = { ...(await this.worker.readSnapshot(targetDate)), cardsPerMessage: broadcast.cardsPerMessage };
      const caption = renderCaption(broadcast.captionTemplate, { now, targetDate });
      const rendered = snapshot.orders.length ? await this.worker.renderChecked(snapshot) : [];
      const expiresAt = new Date(Date.now() + BROADCAST_IMAGE_TTL_MS);
      const stored = await this.store.withStoreLock(async (assertStoreOwned) => {
        const files = await this.store.writePages(rendered, expiresAt, assertStoreOwned);
        let keep = false;
        try {
          await assertRenderOwned();
          await assertStoreOwned();
          const outcome = await this.repository.createManualRun({
            broadcastId: id, settingsVersion: input.settingsVersion, idempotencyKey: input.idempotencyKey, fingerprint, actor, requestId,
            businessDate: date, targetDate, snapshot, images: toImages(rendered, files, caption), imageExpiresAt: expiresAt,
          }, assertStoreOwned);
          keep = !outcome.replayed;
          return outcome;
        } finally {
          if (!keep) for (const file of files) await this.store.remove(file.fileKey, assertStoreOwned).catch(() => undefined);
        }
      });
      if (!stored) throw new ApiError(503, 'BROADCAST_STORE_BUSY', 'Хранилище рассылок занято; повторите запрос');
      return stored;
    });
    return this.repository.getRunDetail(result.runId);
  }

  async retry(runId: string, input: { mode: 'remaining' | 'all'; idempotencyKey: string; duplicateRiskConfirmed: boolean }, actor: CurrentUser, requestId: string) {
    const broadcastId = await this.repository.runBroadcastId(runId);
    const fingerprint = commandFingerprint({
      kind: 'retry', broadcastId, parentRunId: runId, mode: input.mode, duplicateRiskConfirmed: input.duplicateRiskConfirmed, actorId: actor.id,
    });
    // A lost response is replayed from the ledger even if WhatsApp became unavailable since.
    const replay = await this.repository.findCommand(broadcastId, input.idempotencyKey, fingerprint);
    if (replay) return this.repository.getRunDetail(String(replay.runId));
    if (!this.worker.runtime().relayAvailable) throw new ApiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE', 'WhatsApp relay is unavailable');
    const result = await this.repository.createRetry(runId, { ...input, actor, requestId, fingerprintFor: () => fingerprint });
    return this.repository.getRunDetail(result.runId);
  }

  async replan(id: number, input: { version: number; idempotencyKey: string }, actor: CurrentUser, requestId: string) {
    await this.repository.replanToday({
      broadcastId: id, version: input.version, idempotencyKey: input.idempotencyKey, actor, requestId, now: new Date(),
      fingerprint: commandFingerprint({ kind: 'replan', broadcastId: id, version: input.version, actorId: actor.id }),
    });
    return this.get(id);
  }

  runs(id: number) {
    return this.repository.getBroadcast(id).then(() => this.repository.listRuns(id)).then((runs) => ({ runs }));
  }

  run(runId: string) { return this.repository.getRunDetail(runId); }

  async image(runId: string, seq: number) {
    if (!this.worker.storeReady) throw new ApiError(503, 'BROADCAST_STORE_UNAVAILABLE', 'Хранилище рассылок временно недоступно');
    const metadata = await this.repository.getImageMetadata(runId, seq);
    if (!metadata.imageAvailable) throw new ApiError(410, 'BROADCAST_IMAGE_EXPIRED', 'Срок хранения изображения истёк');
    const stored = await this.store.withStoreLock((owned) => this.store.readImage(metadata.fileKey, metadata.sha256, metadata.expiresAt, owned));
    if (!stored) throw new ApiError(503, 'BROADCAST_STORE_BUSY', 'Хранилище рассылок занято');
    return stored;
  }
}

