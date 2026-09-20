import { ApiError } from '../../../common/errors/api-error';
import { safeBitrixError } from '../../audit/application/bitrix-audit-sanitization';
import type { Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { StageRepository, type StageWork } from './stage-repository';
import {
  normalizeStages,
  stageError,
  targetStage,
  verifyDeal,
  type StageConfig,
  type StageOrder,
} from './stage-policy';

export class StageWorker {
  constructor(
    private readonly repo: StageRepository,
    private readonly bitrix: Bitrix24ApiPort,
    private readonly runtime: CrmSyncRuntimeConfigService
  ) {}
  private assertPortal(c: StageConfig): void {
    const webhook = this.runtime.getBitrix24().webhookUrl;
    if (
      !webhook ||
      new URL(webhook).hostname !== c.domain ||
      this.runtime.getReverseSync().portalDomain !== c.domain
    )
      throw stageError(
        'PORTAL_CONFLICT',
        'Портал прямой и обратной синхронизации не совпадает'
      );
  }
  async runLocked(proveWriter: () => Promise<void>): Promise<void> {
    const flags = this.runtime.getFlags();
    const reverse = this.runtime.getReverseSync();
    if (
      !flags.enabled ||
      flags.dryRun ||
      flags.relayOwner !== 'in_process' ||
      !reverse.enabled ||
      reverse.dryRun ||
      reverse.relayOwner !== 'in_process'
    )
      return;
    const cfg = await this.repo.config();
    if (!cfg.enabled) return;
    this.assertPortal(cfg);
    for (let i = 0; i < Math.min(25, flags.batchSize); i++) {
      await proveWriter();
      const w = await this.repo.claim(flags.leaseMs);
      if (!w) return;
      await this.process(w, proveWriter);
    }
  }
  private async process(
    w: StageWork,
    proveWriter: () => Promise<void>
  ): Promise<void> {
    const c = await this.repo.config();
    let order: StageOrder | null = null;
    const guard = async () => {
      await proveWriter();
      await this.repo.prove(w, c);
      const latest = await this.repo.order(w.order_id);
      if (
        !latest ||
        !order ||
        latest.order_status_id !== order.order_status_id ||
        latest.bitrix_id !== order.bitrix_id ||
        latest.mapping_status !== order.mapping_status ||
        latest.source_system !== order.source_system ||
        latest.request_state !== order.request_state ||
        latest.request_deal !== order.request_deal ||
        latest.linked_order_id !== order.linked_order_id ||
        latest.delete_flag ||
        latest.order_kind !== 'production_order'
      )
        throw stageError('STALE_WORK', 'Статус или связь заказа изменились');
      if (w.approval && latest.version !== w.approval.orderVersion)
        throw stageError(
          'PREVIEW_STALE',
          'Заказ изменился после предпросмотра'
        );
    };
    try {
      this.assertPortal(c);
      order = await this.repo.order(w.order_id);
      if (
        !order ||
        order.delete_flag ||
        order.order_kind !== 'production_order'
      )
        throw stageError(
          'ORDER_INELIGIBLE',
          'Заказ больше не участвует в передаче'
        );
      if (!order.bitrix_id) {
        await this.repo.finish(w, c, order, 'waiting_mapping', null);
        return;
      }
      const catalog = await this.repo.catalog(c);
      const mappings = await this.repo.mappings(c);
      const target = targetStage(
        order.order_status_id,
        mappings.find((m) => m.order_status_id === order!.order_status_id)
          ?.stage_id,
        catalog?.stages ?? [],
        c.completed_status_id
      );
      await this.bitrix.withRequestGuard(guard, async () => {
        const remote = await this.bitrix.getCrmItem(2, order!.bitrix_id!);
        if (!remote)
          throw stageError(
            'DEAL_MISSING',
            'Сделка недоступна. Автоматическое создание запрещено'
          );
        verifyDeal(order!, remote, c);
        const observed = String(remote.stageId);
        // Recover own prepared attempts before checking preview's old remote state.
        const receipt = await this.repo.db.query<{ attempt_id: string }>(
          `SELECT attempt_id FROM bitrix24_stage_attempt WHERE member_id=$1 AND category_id=$2 AND order_id=$3 AND epoch=$4 AND revision=$5 AND config_version=$6 AND bitrix_id=$7 AND target_stage=$8 AND state IN ('prepared','uncertain') ORDER BY created_at DESC LIMIT 1`,
          [
            w.member_id,
            w.category_id,
            w.order_id,
            w.epoch,
            w.revision,
            c.version,
            order!.bitrix_id,
            target.id,
          ]
        );
        if (w.approval && !(receipt.rows[0] && observed === target.id)) {
          const a = w.approval;
          if (
            a.epoch !== c.epoch ||
            a.configVersion !== c.version ||
            a.statusId !== order!.order_status_id ||
            a.orderVersion !== order!.version ||
            a.bitrixId !== order!.bitrix_id ||
            a.observed !== observed ||
            a.target !== target.id
          )
            throw stageError(
              'PREVIEW_STALE',
              'Предпросмотр устарел. Выполните сверку заново'
            );
        }
        if (observed === target.id) {
          if (receipt.rows[0])
            await this.verifyReceipt(
              receipt.rows[0].attempt_id,
              order!,
              w,
              target.id
            );
          await this.repo.finish(
            w,
            c,
            order,
            'processed',
            null,
            observed,
            target.id
          );
          return;
        }
        if (!this.bitrix.updateDealStage)
          throw stageError(
            'CLIENT_UNAVAILABLE',
            'Клиент передачи стадий недоступен',
            503
          );
        // Re-read live stage catalog: removed/changed semantics must block, not
        // silently reopen/close a Deal using stale administrative cache.
        if (!this.bitrix.listDealStages)
          throw stageError(
            'CLIENT_UNAVAILABLE',
            'Клиент справочника стадий недоступен',
            503
          );
        targetStage(
          order!.order_status_id,
          target.id,
          normalizeStages(await this.bitrix.listDealStages(c.category_id!)),
          c.completed_status_id
        );
        await guard();
        const restoration =
          w.initialized && w.applied_status_id === order!.order_status_id;
        const attempt = await this.repo.prepare(
          w,
          c,
          order!,
          observed,
          target.id
        );
        try {
          await this.bitrix.updateDealStage(order!.bitrix_id!, target.id);
        } catch (error) {
          await this.repo.db.query(
            "UPDATE bitrix24_stage_attempt SET state='uncertain' WHERE attempt_id=$1 AND state='prepared'",
            [attempt]
          );
          throw error; // next tick reads remote before any resend
        }
        const checked = await this.bitrix.getCrmItem(2, order!.bitrix_id!);
        if (!checked)
          throw stageError('DEAL_MISSING', 'Сделка недоступна после передачи');
        verifyDeal(order!, checked, c);
        if (checked.stageId !== target.id)
          throw stageError(
            'REMOTE_CHANGED',
            'Bitrix изменил стадию после записи',
            502
          );
        await this.verifyReceipt(
          attempt,
          order!,
          w,
          target.id,
          restoration ? 'restored' : 'sync_applied'
        );
        await this.repo.finish(
          w,
          c,
          order,
          'processed',
          null,
          target.id,
          target.id
        );
      });
    } catch (error) {
      const message = safeBitrixError(
        error instanceof Error ? error.message : String(error)
      );
      const stale =
        error instanceof ApiError && error.code === 'BITRIX24_STAGE_STALE_WORK';
      const blocked =
        error instanceof ApiError && error.statusCode < 500 && !stale;
      const state = blocked
        ? 'blocked'
        : w.attempts + 1 >= this.runtime.getFlags().maxAttempts
        ? 'failed'
        : 'pending';
      await this.repo.finish(
        w,
        c,
        order,
        state,
        message,
        undefined,
        undefined,
        stale ? undefined : blocked ? 'sync_blocked' : 'sync_failed'
      );
    }
  }
  private async verifyReceipt(
    id: string,
    order: StageOrder,
    w: StageWork,
    target: string,
    event = 'sync_applied'
  ): Promise<void> {
    await this.repo.db.transaction(async (tx) => {
      const r = await tx.query<{ before_stage: string }>(
        "UPDATE bitrix24_stage_attempt SET state='verified',verified_at=now() WHERE attempt_id=$1 AND state IN ('prepared','uncertain') RETURNING before_stage",
        [id]
      );
      if (r.rowCount)
        await this.repo.record(
          tx,
          event,
          { id: w.actor_user_id ?? '', requestId: w.request_id },
          {
            operationId: id,
            bitrixId: order.bitrix_id,
            memberId: w.member_id,
            categoryId: w.category_id,
            epoch: w.epoch,
            revision: w.revision,
            before: { stageId: r.rows[0].before_stage },
            after: { stageId: target },
            targetStage: target,
          },
          order
        );
    });
  }
}
