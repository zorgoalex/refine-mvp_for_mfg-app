import { KNOWN_SUPPLIER_SQL } from './pg-onec-documents-repository';
import type { QueryResultRow } from 'pg';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { balloonFor } from '../../notifications-engine/application/notification-delivery';
import type { BalloonMode, NotificationChannel } from '../../notifications-engine/domain/notification-rule.types';
import { loadEvaluationUsersWith } from '../../../permissions/user-authorization-snapshot';
import { PROCUREMENT_DIGEST_SOURCE } from '../../notifications-engine/domain/notification-event-registry';
import { PROCUREMENT_WORKLIST_DONE_STATUS_CODES } from '../application/procurement-workspace.types';
import {
  applyProcurement,
  loadProcurementRows,
  loadProjectedOrders,
  ORDER_SELECT_SQL,
  type ResourceDemandOrderRow,
} from './pg-order-resource-demand-repository';

/** Сколько заказов с отметкой «Закуплено» сканер проверяет за проход (§5.7 п.2). */
export const DEMAND_SCAN_ORDER_LIMIT = 500;
/** «Приход не распределён»: документы не старше стольких дней (иначе первый запуск — лавина по старым приходам). */
export const UNALLOCATED_LOOKBACK_DAYS = 30;
/** Порция документов «приход не распределён» за один запрос (обход — по курсору до конца). */
export const UNALLOCATED_DOCUMENT_LIMIT = 200;

interface DemandChangeEvent {
  orderId: number;
  key: string;
  payload: Record<string, unknown>;
}

export interface UnallocatedReceiptRow {
  documentId: number;
  number: string;
  docDate: string;
  supplierName: string | null;
  lines: number;
  /** Хеш остатков нераспределённых строк: изменился остаток — новое уведомление (§5.7 п.4). */
  remainingHash: string;
}

/** Состояние правила-включателя сервиса: включено ли и кому слать (пусто — умолчание сервиса). */
export interface ServiceRuleState {
  ruleCode: string;
  isEnabled: boolean;
  roleCodes: string[];
  /** Access groups (plan v6 §5): members of active groups while the switch is on; a rule with them is not «default». */
  groupCodes: string[];
  userIds: number[];
  /** md5 `recipients_json` — сверка в транзакции записи: сменились получатели — запись прогона пропускается (R1-4). */
  recipientsHash: string;
}

/** Сверка с правилом в транзакции записи: правило выключено или получатели сменились — запись не делается. */
export interface ServiceRuleGuard {
  ruleCode: string;
  recipientsHash: string;
  /**
   * Access groups (plan v6 §5): the recipient is checked again at write time against the rule's current recipients and
   * the current memberships/switch — group changes do not change the rule's hash. Same arguments as ruleRecipients.
   */
  eligibility?: {
    defaultPermission: string;
    required: string[];
    /**
     * permissions_state.version read before the recipients were selected and their content computed (scope): any
     * authorization change since (a narrowed scope included) skips the write; the next run recomputes.
     */
    authorizationVersion?: number;
  };
}

export interface ServiceNotificationInput {
  eventType: 'procurement.deficit_digest' | 'procurement.receipt_unallocated';
  aggregateType: string;
  aggregateId: string;
  /** Ключ идемпотентности события; ключ уведомления — `${key}:in_app`. */
  key: string;
  userId: number;
  title: string;
  message: string;
  entityType: string;
  entityId: string | null;
}

/**
 * Хранилище уведомлений закупа по расписанию (план 2026-09-28 §5.7 п.2, п.4): включатели-правила, получатели по
 * буквальному праву (текущая матрица ролей), сканер «потребность изменилась после отметки», нераспределённые приходы,
 * запись уведомления сервиса вместе с событием outbox (одна транзакция, идемпотентно по ключу).
 */
/** Users a service rule reaches (see ruleRecipients); `$6` narrows to one user (the write-time check). */
const ELIGIBLE_USERS_SQL = `SELECT u.user_id::text AS user_id, u.username, u.role_id
         FROM users u
         JOIN roles r ON r.role_id = u.role_id AND r.is_active = true
        WHERE u.is_active = true AND COALESCE(u.is_service_account, false) = false
          AND CASE WHEN $1::text IS NOT NULL
                   THEN EXISTS (SELECT 1 FROM user_effective_permissions uep
                                 WHERE uep.user_id = u.user_id AND uep.permission_name = $1)
                   ELSE (r.role_code = ANY($2::text[]) OR u.user_id = ANY($3::bigint[])
                         OR EXISTS (SELECT 1 FROM user_access_groups uag
                                      JOIN access_groups ag ON ag.group_id = uag.group_id AND ag.is_active
                                      JOIN permissions_state ps ON ps.id AND ps.access_groups_enabled
                                     WHERE uag.user_id = u.user_id AND ag.code = ANY($5::text[]))) END
          AND NOT EXISTS (
            SELECT 1 FROM unnest($4::text[]) AS need(permission_name)
             WHERE NOT EXISTS (SELECT 1 FROM user_effective_permissions uep
                                WHERE uep.user_id = u.user_id AND uep.permission_name = need.permission_name))
          AND ($6::bigint IS NULL OR u.user_id = $6::bigint)
        ORDER BY u.user_id`;

export class PgProcurementNotificationsRepository {
  private readonly write = new PgNotificationWriteAdapter();

  private readonly demandBatch: number;
  private readonly receiptBatch: number;

  /** Только для тестов гонок: пауза после блокировки строки правила, до вставок (детерминированный порядок). */
  private readonly afterRuleLocked?: () => Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    limits: { demandBatch?: number; receiptBatch?: number; afterRuleLocked?: () => Promise<void> } = {},
  ) {
    this.afterRuleLocked = limits.afterRuleLocked;
    this.demandBatch = limits.demandBatch ?? DEMAND_SCAN_ORDER_LIMIT;
    this.receiptBatch = limits.receiptBatch ?? UNALLOCATED_DOCUMENT_LIMIT;
  }

  async isRuleEnabled(ruleCode: string): Promise<boolean> {
    const row = (await this.database.query<{ is_enabled: boolean }>(
      'SELECT is_enabled FROM notification_rules WHERE rule_code = $1',
      [ruleCode],
    )).rows[0];
    return row?.is_enabled === true;
  }

  async loadSettings(): Promise<{ digestTime: string; unallocatedAlertDays: number } | null> {
    const row = (await this.database.query<{ digest_time: string; unallocated_alert_days: number }>(
      `SELECT to_char(digest_time, 'HH24:MI') AS digest_time, unallocated_alert_days FROM procurement_settings LIMIT 1`,
    )).rows[0];
    return row ? { digestTime: row.digest_time, unallocatedAlertDays: Number(row.unallocated_alert_days) } : null;
  }

  /** Активные пользователи, у роли которых буквально есть право (матрица ролей, не статические умолчания). */
  async permissionHolders(permission: string): Promise<CurrentUser[]> {
    return this.selectUsers({ byPermission: permission, roleCodes: [], groupCodes: [], userIds: [] }, [permission]);
  }

  /** permissions_state.version — captured before a digest run selects recipients and computes their content. */
  async authorizationVersion(): Promise<number> {
    const row = (await this.database.query<{ version: string }>('SELECT version FROM permissions_state WHERE id = true')).rows[0];
    return Number(row?.version ?? 0);
  }

  async loadRule(ruleCode: string): Promise<ServiceRuleState> {
    const row = (await this.database.query<{ is_enabled: boolean; recipients_json: unknown; recipients_hash: string }>(
      `SELECT is_enabled, recipients_json, md5(COALESCE(recipients_json, '{}'::jsonb)::text) AS recipients_hash
         FROM notification_rules WHERE rule_code = $1`,
      [ruleCode],
    )).rows[0];
    return {
      ruleCode,
      isEnabled: row?.is_enabled === true,
      ...parseServiceRecipients(row?.recipients_json),
      recipientsHash: row?.recipients_hash ?? '',
    };
  }

  /**
   * Получатели сервисного правила (план 2026-10-02 §2.1): пусто — умолчание (право `defaultPermission`), иначе —
   * пользователи выбранных ролей ∪ выбранные пользователи; ВСЕГДА только активные несервисные с каждым правом из
   * `required` (буквально по матрице ролей) — данные закупа не уходят тому, кто их не видит.
   */
  async ruleRecipients(rule: Pick<ServiceRuleState, 'roleCodes' | 'groupCodes' | 'userIds'>, defaultPermission: string, required: string[]): Promise<CurrentUser[]> {
    // groupCodes make the rule custom even while access groups are off: then they reach nobody, never «everybody».
    const groupCodes = rule.groupCodes ?? [];
    const custom = rule.roleCodes.length > 0 || groupCodes.length > 0 || rule.userIds.length > 0;
    return this.selectUsers(custom
      ? { byPermission: null, roleCodes: rule.roleCodes, groupCodes, userIds: rule.userIds }
      : { byPermission: defaultPermission, roleCodes: [], groupCodes: [], userIds: [] }, required);
  }

  private async selectUsers(
    filter: { byPermission: string | null; roleCodes: string[]; groupCodes: string[]; userIds: number[] },
    required: string[],
  ): Promise<CurrentUser[]> {
    const rows = (await this.database.query<{ user_id: string; username: string | null; role_id: string | number }>(
      ELIGIBLE_USERS_SQL,
      [filter.byPermission, filter.roleCodes, filter.userIds, required, filter.groupCodes, null],
    )).rows;
    // Effective authorization of each user (same snapshot as the token), in the order of the query.
    const effective = await loadEvaluationUsersWith(this.database, rows.map((row) => row.user_id), { requireActiveRole: true });
    const users: CurrentUser[] = rows
      .map((row) => effective.get(String(row.user_id)))
      .filter((user): user is CurrentUser => Boolean(user));
    return users;
  }

  /**
   * Сканер §5.7 п.2: строки закупа с отметкой «Закуплено», потребность которых изменилась после отметки, → событие
   * `order.resource_demand_changed_after_mark` с ключом `…:{orderId}:{resourceKey}:{currentFingerprint}` — одно на
   * изменение (повтор прохода ничего не создаёт). Заказы — действующие, производственные, не завершённые. Обход —
   * порциями по курсору order_id через ВСЕ подходящие заказы на каждом проходе (CR1-1). Потребность и отметки порции
   * читаются из ОДНОГО снимка (REPEATABLE READ READ ONLY, CR1-4); события пишутся после, по одному, и только пока
   * `shouldContinue()` (флаг и правило — CR1-3).
   */
  async scanDemandChanges(
    shouldContinue: () => Promise<boolean>,
    testHooks: { afterProjection?: () => Promise<void> } = {},
  ): Promise<number> {
    let created = 0;
    let cursor = 0;
    for (;;) {
      const batch = await this.database.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const orderRows = (await client.query<ResourceDemandOrderRow>(
          `${ORDER_SELECT_SQL}
            WHERE o.order_id IN (
              SELECT DISTINCT orp.order_id
                FROM order_resource_procurement orp
                JOIN orders po ON po.order_id = orp.order_id
                LEFT JOIN order_statuses os ON os.order_status_id = po.order_status_id
               WHERE orp.purchased AND po.delete_flag = false AND po.order_kind = 'production_order'
                 AND po.issue_date IS NULL AND po.completion_date IS NULL
                 AND COALESCE(os.order_status_code, '') <> ALL ($1::text[])
                 AND orp.order_id > $3
               ORDER BY orp.order_id
               LIMIT $2)
            ORDER BY o.order_id`,
          [PROCUREMENT_WORKLIST_DONE_STATUS_CODES, this.demandBatch, cursor],
        )).rows;
        if (orderRows.length === 0) return { events: [] as DemandChangeEvent[], lastOrderId: null, full: false };
        const projected = await loadProjectedOrders(client, orderRows, undefined);
        await testHooks.afterProjection?.();
        const procurement = await loadProcurementRows(client, projected.map((order) => order.orderId));
        const events: DemandChangeEvent[] = [];
        for (const order of projected) {
          const own = procurement.filter((row) => Number(row.order_id) === order.orderId);
          for (const { line } of applyProcurement(order.lines, own)) {
            if (!line.procurement.purchased || !line.procurement.changedSinceMark) continue;
            events.push({
              orderId: order.orderId,
              key: `procurement_demand_changed:${order.orderId}:${line.resourceKey}:${line.demandFingerprint}`,
              payload: {
                eventType: 'order.resource_demand_changed_after_mark',
                orderId: order.orderId,
                resourceKey: line.resourceKey,
                resourceKind: line.kind,
                refId: line.refId,
                quantity: line.quantity,
                unit: line.unit,
                quantityAtMark: line.procurement.quantityAtMark,
                unitAtMark: line.procurement.unitAtMark,
                demandFingerprint: line.demandFingerprint,
                orphan: line.orphan,
                source: 'procurement_scanner',
              },
            });
          }
        }
        return { events, lastOrderId: Math.max(...orderRows.map((row) => Number(row.order_id))), full: orderRows.length >= this.demandBatch };
      });
      for (const event of batch.events) {
        if (!(await shouldContinue())) return created;
        const inserted = await this.database.query(
          `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
           VALUES ('order.resource_demand_changed_after_mark', 'order', $1, $2::jsonb, $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [String(event.orderId), JSON.stringify(event.payload), event.key],
        );
        created += inserted.rowCount ?? 0;
      }
      if (!batch.full || batch.lastOrderId === null) return created;
      cursor = batch.lastOrderId;
    }
  }

  /**
   * Нераспределённые приходы §5.7 п.4: проведённый, действующий (не удалён, есть в выгрузке) приход старше порога, не
   * старше окна, с материальными строками, у которых остался нераспределённый остаток. Только приходы поставщиков
   * из справочника ERP (решение пользователя 2026-10-04): контрагент документа сейчас связан с поставщиком
   * (`suppliers.ref_key_1c`) — тот же отбор, что в списке приходов экрана снабжения.
   */
  async unallocatedReceipts(
    olderThan: string,
    notBefore: string,
    after: { docDate: string; documentId: number } | null = null,
  ): Promise<UnallocatedReceiptRow[]> {
    const rows = (await this.database.query<{
      document_id: string; number: string; doc_date: string; supplier_name: string | null; lines: number; remaining_hash: string;
    } & QueryResultRow>(
      `SELECT d.onec_document_id::text AS document_id, d.number, d.doc_date::text AS doc_date,
              COALESCE(s.supplier_name, d.counterparty_name) AS supplier_name,
              count(*)::int AS lines,
              md5(string_agg(l.onec_document_line_id::text || ':' || (l.quantity - COALESCE(alloc.quantity, 0))::text, ','
                ORDER BY l.onec_document_line_id)) AS remaining_hash
         FROM onec_documents d
         JOIN onec_document_lines l ON l.onec_document_id = d.onec_document_id
         LEFT JOIN suppliers s ON s.supplier_id = d.supplier_id
         LEFT JOIN LATERAL (
           SELECT sum(a.quantity) AS quantity FROM order_resource_onec_allocations a
            WHERE a.onec_document_line_id = l.onec_document_line_id AND a.removed_at IS NULL AND a.role = 'receipt'
         ) alloc ON true
        WHERE d.doc_kind = 'purchase_receipt' AND d.posted AND NOT d.deleted_in_onec AND d.missing_in_source_at IS NULL
          AND d.doc_date <= $1::date AND d.doc_date >= $2::date
          AND l.removed_in_onec_at IS NULL AND NOT l.is_document_total
          AND (l.sheet_material_type_id IS NOT NULL OR l.film_id IS NOT NULL)
          AND l.quantity - COALESCE(alloc.quantity, 0) > 0.0005
          AND ${KNOWN_SUPPLIER_SQL}
          -- Порции по курсору (дата, id) — обход всех документов окна (CR1-1).
          AND ($4::date IS NULL OR (d.doc_date, d.onec_document_id) > ($4::date, $5::bigint))
        GROUP BY d.onec_document_id, d.number, d.doc_date, s.supplier_name, d.counterparty_name
        ORDER BY d.doc_date, d.onec_document_id
        LIMIT $3`,
      [olderThan, notBefore, this.receiptBatch, after?.docDate ?? null, after?.documentId ?? 0],
    )).rows;
    return rows.map((row) => ({
      documentId: Number(row.document_id),
      number: row.number,
      docDate: row.doc_date,
      supplierName: row.supplier_name,
      lines: Number(row.lines),
      remainingHash: row.remaining_hash,
    }));
  }

  private async stillEligible(
    client: DatabaseClient,
    userId: number,
    recipientsJson: unknown,
    eligibility: NonNullable<ServiceRuleGuard['eligibility']>,
  ): Promise<boolean> {
    const recipients = parseServiceRecipients(recipientsJson);
    const custom = recipients.roleCodes.length > 0 || recipients.groupCodes.length > 0 || recipients.userIds.length > 0;
    const rows = await client.query(ELIGIBLE_USERS_SQL, custom
      ? [null, recipients.roleCodes, recipients.userIds, eligibility.required, recipients.groupCodes, userId]
      : [eligibility.defaultPermission, [], [], eligibility.required, [], userId]);
    return (rows.rowCount ?? 0) > 0;
  }

  /**
   * Уведомление сервиса (§5.7 п.4): событие outbox с ключом идемпотентности и in_app-запись с ключом `${key}:in_app`
   * в одной транзакции; повтор с тем же ключом ничего не создаёт. Событие сразу «processed»: реле его не обрабатывает.
   */
  async writeServiceNotification(input: ServiceNotificationInput, guard?: ServiceRuleGuard): Promise<boolean> {
    return this.database.transaction(async (client: DatabaseClient) => {
      let balloonMode: BalloonMode | null = null;
      if (guard) {
        // Access groups: authorization commands (memberships, the switch) take permissions_state FOR UPDATE first; this
        // share lock — taken first here too — orders the write after any such change, so the check below sees it.
        if (guard.eligibility) {
          const state = await client.query<{ version: string }>('SELECT version FROM permissions_state WHERE id = true FOR SHARE');
          const authorizationVersion = guard.eligibility.authorizationVersion;
          if (authorizationVersion !== undefined && Number(state.rows[0]?.version) !== authorizationVersion) return false;
        }
        // Точка сериализации с PATCH правила (R1-4): FOR SHARE строки правила ДО вставок; выключено или получатели
        // сменились после выборки прогона — запись пропускается (следующий прогон выберет заново).
        const rule = (await client.query<{ is_enabled: boolean; recipients_hash: string; recipients_json: unknown; channels_json: unknown; balloon_mode: string | null }>(
          `SELECT is_enabled, md5(COALESCE(recipients_json, '{}'::jsonb)::text) AS recipients_hash, recipients_json, channels_json, balloon_mode
             FROM notification_rules WHERE rule_code = $1 FOR SHARE`,
          [guard.ruleCode],
        )).rows[0];
        if (!rule || rule.is_enabled !== true || rule.recipients_hash !== guard.recipientsHash) return false;
        // The recipient now: still in the rule's audience (role, user, ACTIVE group with the switch on) and with the
        // required rights — a removal or the switch turned off between the selection and this write drops the write.
        if (guard.eligibility && !(await this.stillEligible(client, input.userId, rule.recipients_json, guard.eligibility))) return false;
        // Балун — по строке правила под той же блокировкой (план 2026-10-03 R1-4): смена канала/режима во время прохода
        // учитывается в момент записи.
        balloonMode = balloonFor({
          channels: Array.isArray(rule.channels_json) ? rule.channels_json.filter((channel): channel is NotificationChannel =>
            channel === 'in_app' || channel === 'balloon' || channel === 'telegram') : ['in_app'],
          balloonMode: rule.balloon_mode === 'persistent' ? 'persistent' : 'auto',
        });
        await this.afterRuleLocked?.();
      }
      const event = await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, status, processed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'processed', now())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [input.eventType, input.aggregateType, input.aggregateId,
          JSON.stringify({ eventType: input.eventType, userId: input.userId, entityType: input.entityType, entityId: input.entityId }),
          input.key],
      );
      if ((event.rowCount ?? 0) === 0) return false;
      const result = await this.write.insertIfAbsent(client, {
        userId: input.userId,
        level: 'info',
        title: input.title,
        message: input.message,
        entityType: input.entityType,
        entityId: input.entityId,
        sourceType: PROCUREMENT_DIGEST_SOURCE,
        sourceId: input.eventType,
        idempotencyKey: `${input.key}:in_app`,
        balloonMode,
      });
      return result.created;
    });
  }
}

/** Recipients of a service rule as stored (unknown shapes ignored). */
function parseServiceRecipients(value: unknown): { roleCodes: string[]; groupCodes: string[]; userIds: number[] } {
  const recipients = (value ?? {}) as { roleCodes?: unknown; groupCodes?: unknown; userIds?: unknown };
  const codes = (list: unknown) => (Array.isArray(list) ? list.filter((code): code is string => typeof code === 'string') : []);
  return {
    roleCodes: codes(recipients.roleCodes),
    groupCodes: codes(recipients.groupCodes),
    userIds: Array.isArray(recipients.userIds) ? recipients.userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
  };
}
