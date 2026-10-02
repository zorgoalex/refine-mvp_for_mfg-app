import type { CurrentUser } from '../../../permissions/current-user';
import type { ServiceNotificationInput, ServiceRuleGuard, ServiceRuleState, UnallocatedReceiptRow } from '../adapters/pg-procurement-notifications-repository';
import { UNALLOCATED_LOOKBACK_DAYS } from '../adapters/pg-procurement-notifications-repository';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import {
  addUnallocatedPage, digestText, isDigestDue, PROCUREMENT_NOTIFICATION_RULES, UNALLOCATED_OLD_DAYS, unallocatedDigestText, type UnallocatedDigestTotals,
} from '../domain/procurement-notifications';

export interface ProcurementNotificationsRepositoryPort {
  isRuleEnabled(ruleCode: string): Promise<boolean>;
  loadSettings(): Promise<{ digestTime: string; unallocatedAlertDays: number } | null>;
  loadRule(ruleCode: string): Promise<ServiceRuleState>;
  ruleRecipients(rule: Pick<ServiceRuleState, 'roleCodes' | 'userIds'>, defaultPermission: string, required: string[]): Promise<CurrentUser[]>;
  scanDemandChanges(shouldContinue: () => Promise<boolean>): Promise<number>;
  unallocatedReceipts(olderThan: string, notBefore: string, after?: { docDate: string; documentId: number } | null): Promise<UnallocatedReceiptRow[]>;
  writeServiceNotification(input: ServiceNotificationInput, guard?: ServiceRuleGuard): Promise<boolean>;
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
  /** Правила-включатели на начале прохода (лог завершения прохода, R2-1). */
  rulesEnabled?: { demandChanged: boolean; digest: boolean; unallocated: boolean };
}

/** Умолчание получателей сервисных правил (пустые `recipients`): снабженцы — право «Закупки: управление» (план §2.1). */
export const SERVICE_RULE_DEFAULT_PERMISSION = 'procurement.manage';

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
    summary.rulesEnabled = {
      demandChanged: await this.deps.repository.isRuleEnabled(rules.demandChanged),
      digest: await this.deps.repository.isRuleEnabled(rules.digest),
      unallocated: await this.deps.repository.isRuleEnabled(rules.unallocated),
    };

    await this.isolate(summary, 'demand', async () => {
      if (!(await this.stillOn(rules.demandChanged))) return;
      summary.demandEvents = await this.deps.repository.scanDemandChanges(() => this.stillOn(rules.demandChanged));
    });

    if (!isDigestDue(now, settings.digestTime)) return summary;

    // Сводка дефицита: каждому получателю по его scope; получатели — правило или умолчание, всегда с procurement.manage.
    await this.isolate(summary, 'digest', async () => {
      const rule = await this.deps.repository.loadRule(rules.digest);
      if (!rule.isEnabled || !this.deps.enabled()) return;
      const guard = { ruleCode: rule.ruleCode, recipientsHash: rule.recipientsHash };
      for (const user of await this.deps.repository.ruleRecipients(rule, SERVICE_RULE_DEFAULT_PERMISSION, ['procurement.manage'])) {
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
          }, guard)) summary.digests += 1;
        });
      }
    });

    // Нераспределённые приходы: ОДНА сводка в день на получателя (план 2026-10-02 §2.2), а не уведомление на приход.
    await this.isolate(summary, 'unallocated', async () => {
      const rule = await this.deps.repository.loadRule(rules.unallocated);
      if (!rule.isEnabled || !this.deps.enabled()) return;
      const users = await this.deps.repository.ruleRecipients(rule, SERVICE_RULE_DEFAULT_PERMISSION, ['procurement.view']);
      if (users.length === 0) return;
      const olderThan = addDays(today, -settings.unallocatedAlertDays);
      const notBefore = addDays(today, -(settings.unallocatedAlertDays + UNALLOCATED_LOOKBACK_DAYS));
      const oldBefore = addDays(today, -UNALLOCATED_OLD_DAYS);
      let totals: UnallocatedDigestTotals = { documents: 0, lines: 0, old: 0, oldest: [] };
      let after: { docDate: string; documentId: number } | null = null;
      for (;;) {
        if (!(await this.stillOn(rules.unallocated))) return;
        const page: UnallocatedReceiptRow[] = await this.deps.repository.unallocatedReceipts(olderThan, notBefore, after);
        // До пустой порции: размер порции — дело хранилища (CR1-1).
        if (page.length === 0) break;
        totals = addUnallocatedPage(totals, page, oldBefore);
        const last = page[page.length - 1];
        after = { docDate: last.docDate, documentId: last.documentId };
      }
      const text = unallocatedDigestText(totals, today);
      if (!text) return;
      const guard = { ruleCode: rule.ruleCode, recipientsHash: rule.recipientsHash };
      for (const user of users) {
        if (!(await this.stillOn(rules.unallocated))) return;
        await this.isolate(summary, `unallocated:${user.id}`, async () => {
          if (await this.deps.repository.writeServiceNotification({
            eventType: 'procurement.receipt_unallocated', aggregateType: 'user', aggregateId: user.id,
            key: `procurement_unallocated_digest:${user.id}:${today}`, userId: Number(user.id),
            ...text, entityType: 'procurement_receipts', entityId: null,
          }, guard)) summary.unallocated += 1;
        });
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
