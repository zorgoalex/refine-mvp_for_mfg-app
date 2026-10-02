import type { CurrentUser } from '../../../permissions/current-user';
import type { ServiceNotificationInput, UnallocatedReceiptRow } from '../adapters/pg-procurement-notifications-repository';
import { UNALLOCATED_LOOKBACK_DAYS } from '../adapters/pg-procurement-notifications-repository';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import { digestText, isDigestDue, PROCUREMENT_NOTIFICATION_RULES, unallocatedText } from '../domain/procurement-notifications';

export interface ProcurementNotificationsRepositoryPort {
  isRuleEnabled(ruleCode: string): Promise<boolean>;
  loadSettings(): Promise<{ digestTime: string; unallocatedAlertDays: number } | null>;
  permissionHolders(permission: string): Promise<CurrentUser[]>;
  scanDemandChanges(shouldContinue: () => Promise<boolean>): Promise<number>;
  unallocatedReceipts(olderThan: string, notBefore: string, after?: { docDate: string; documentId: number } | null): Promise<UnallocatedReceiptRow[]>;
  writeServiceNotification(input: ServiceNotificationInput): Promise<boolean>;
}

export interface ProcurementNotificationsDeps {
  repository: ProcurementNotificationsRepositoryPort;
  /** Итоги рабочего списка получателя порциями, без лимитов экрана (CR2-1). */
  worklist: { worklistTotals(user: CurrentUser, options: { procurementEnabled: boolean; supplyWorkspaceEnabled: boolean; supplierRequestsEnabled?: boolean }): Promise<{ uncovered: number; urgent: number; deficitM2: number; deficitLm: number }> };
  /** Флаги закупа + экрана снабжения + уведомлений закупа; читаются на каждом проходе и перед каждой записью. */
  enabled(): boolean;
  supplierRequestsEnabled(): boolean;
  now?: () => Date;
  logger?: { error(message: unknown): void };
}

export interface ProcurementNotificationsRunSummary {
  skipped?: 'disabled';
  demandEvents: number;
  digests: number;
  unallocated: number;
  /** Сбои отдельных получателей/видов (остальные продолжают, CR1-2). */
  failed: number;
}

/**
 * Уведомления закупа по расписанию (§5.7 п.2, п.4, R5-3): флаг проверяется в начале прохода, каждый вид — только при
 * включённом правиле-включателе, а флаг и правило — ЕЩЁ РАЗ перед каждой записью (выключение останавливает начатую
 * рассылку, CR1-3). Виды и получатели изолированы: сбой одного не останавливает остальных (CR1-2). Всё идемпотентно
 * по ключам. Сводка и «приход не распределён» считаются под scope и правами КАЖДОГО получателя.
 */
export class ProcurementNotificationsService {
  constructor(private readonly deps: ProcurementNotificationsDeps) {}

  async runOnce(): Promise<ProcurementNotificationsRunSummary> {
    const summary: ProcurementNotificationsRunSummary = { demandEvents: 0, digests: 0, unallocated: 0, failed: 0 };
    if (!this.deps.enabled()) return { ...summary, skipped: 'disabled' };
    const now = this.deps.now?.() ?? new Date();
    const today = todayInAlmaty(now);
    const settings = await this.deps.repository.loadSettings();
    if (!settings) return summary;
    const rules = PROCUREMENT_NOTIFICATION_RULES;

    await this.isolate(summary, 'demand', async () => {
      if (!(await this.stillOn(rules.demandChanged))) return;
      summary.demandEvents = await this.deps.repository.scanDemandChanges(() => this.stillOn(rules.demandChanged));
    });

    if (isDigestDue(now, settings.digestTime)) {
      await this.isolate(summary, 'digest', async () => {
        if (!(await this.stillOn(rules.digest))) return;
        for (const user of await this.deps.repository.permissionHolders('procurement.manage')) {
          if (!(await this.stillOn(rules.digest))) return;
          await this.isolate(summary, `digest:${user.id}`, async () => {
            const totals = await this.deps.worklist.worklistTotals(user, {
              procurementEnabled: true, supplyWorkspaceEnabled: true, supplierRequestsEnabled: this.deps.supplierRequestsEnabled(),
            });
            const text = digestText(totals, today);
            if (!text || !(await this.stillOn(rules.digest))) return;
            if (await this.deps.repository.writeServiceNotification({
              eventType: 'procurement.deficit_digest', aggregateType: 'user', aggregateId: user.id, key: `procurement_digest:${user.id}:${today}`,
              userId: Number(user.id), ...text, entityType: 'procurement_worklist', entityId: null,
            })) summary.digests += 1;
          });
        }
      });
    }

    await this.isolate(summary, 'unallocated', async () => {
      if (!(await this.stillOn(rules.unallocated))) return;
      const olderThan = addDays(today, -settings.unallocatedAlertDays);
      const notBefore = addDays(today, -(settings.unallocatedAlertDays + UNALLOCATED_LOOKBACK_DAYS));
      const users = await this.deps.repository.permissionHolders('procurement.view');
      if (users.length === 0) return;
      let after: { docDate: string; documentId: number } | null = null;
      for (;;) {
        const page = await this.deps.repository.unallocatedReceipts(olderThan, notBefore, after);
        for (const receipt of page) {
          for (const user of users) {
            if (!(await this.stillOn(rules.unallocated))) return;
            await this.isolate(summary, `unallocated:${user.id}:${receipt.documentId}`, async () => {
              if (await this.deps.repository.writeServiceNotification({
                eventType: 'procurement.receipt_unallocated', aggregateType: 'onec_document', aggregateId: String(receipt.documentId),
                key: `procurement_unallocated:${user.id}:${receipt.documentId}:${receipt.remainingHash}`, userId: Number(user.id),
                ...unallocatedText(receipt), entityType: 'onec_document', entityId: String(receipt.documentId),
              })) summary.unallocated += 1;
            });
          }
        }
        // До пустой порции: размер порции — дело хранилища (CR1-1).
        if (page.length === 0) return;
        const last = page[page.length - 1];
        after = { docDate: last.docDate, documentId: last.documentId };
      }
    });
    return summary;
  }

  /** Флаги и правило-включатель — прямо сейчас (не кешируются). */
  private async stillOn(ruleCode: string): Promise<boolean> {
    return this.deps.enabled() && await this.deps.repository.isRuleEnabled(ruleCode);
  }

  private async isolate(summary: ProcurementNotificationsRunSummary, scope: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      summary.failed += 1;
      this.deps.logger?.error({
        event: 'procurement_notifications_step_failed',
        scope,
        errorCode: (error as { code?: unknown })?.code ?? null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
