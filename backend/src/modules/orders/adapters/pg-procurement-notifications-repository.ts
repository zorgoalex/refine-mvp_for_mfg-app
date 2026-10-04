import { KNOWN_SUPPLIER_SQL } from './pg-onec-documents-repository';
import type { QueryResultRow } from 'pg';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { balloonFor } from '../../notifications-engine/application/notification-delivery';
import type { BalloonMode, NotificationChannel } from '../../notifications-engine/domain/notification-rule.types';
import { loadRoleAuthorizationWith } from '../../notifications-engine/adapters/pg-procurement-recipient-visibility';
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
  userIds: number[];
  /** md5 `recipients_json` — сверка в транзакции записи: сменились получатели — запись прогона пропускается (R1-4). */
  recipientsHash: string;
}

/** Сверка с правилом в транзакции записи: правило выключено или получатели сменились — запись не делается. */
export interface ServiceRuleGuard {
  ruleCode: string;
  recipientsHash: string;
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
    return this.selectUsers({ byPermission: permission, roleCodes: [], userIds: [] }, [permission]);
  }

  async loadRule(ruleCode: string): Promise<ServiceRuleState> {
    const row = (await this.database.query<{ is_enabled: boolean; recipients_json: unknown; recipients_hash: string }>(
      `SELECT is_enabled, recipients_json, md5(COALESCE(recipients_json, '{}'::jsonb)::text) AS recipients_hash
         FROM notification_rules WHERE rule_code = $1`,
      [ruleCode],
    )).rows[0];
    const recipients = (row?.recipients_json ?? {}) as { roleCodes?: unknown; userIds?: unknown };
    return {
      ruleCode,
      isEnabled: row?.is_enabled === true,
      roleCodes: Array.isArray(recipients.roleCodes) ? recipients.roleCodes.filter((code): code is string => typeof code === 'string') : [],
      userIds: Array.isArray(recipients.userIds) ? recipients.userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
      recipientsHash: row?.recipients_hash ?? '',
    };
  }

  /**
   * Получатели сервисного правила (план 2026-10-02 §2.1): пусто — умолчание (право `defaultPermission`), иначе —
   * пользователи выбранных ролей ∪ выбранные пользователи; ВСЕГДА только активные несервисные с каждым правом из
   * `required` (буквально по матрице ролей) — данные закупа не уходят тому, кто их не видит.
   */
  async ruleRecipients(rule: Pick<ServiceRuleState, 'roleCodes' | 'userIds'>, defaultPermission: string, required: string[]): Promise<CurrentUser[]> {
    const custom = rule.roleCodes.length > 0 || rule.userIds.length > 0;
    return this.selectUsers(custom ? { byPermission: null, roleCodes: rule.roleCodes, userIds: rule.userIds } : { byPermission: defaultPermission, roleCodes: [], userIds: [] }, required);
  }

  private async selectUsers(
    filter: { byPermission: string | null; roleCodes: string[]; userIds: number[] },
    required: string[],
  ): Promise<CurrentUser[]> {
    const rows = (await this.database.query<{ user_id: string; username: string | null; role_id: string | number }>(
      `SELECT u.user_id::text AS user_id, u.username, u.role_id
         FROM users u
         JOIN roles r ON r.role_id = u.role_id AND r.is_active = true
        WHERE u.is_active = true AND COALESCE(u.is_service_account, false) = false
          AND CASE WHEN $1::text IS NOT NULL
                   THEN EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active = true
                                 WHERE rp.role_id = u.role_id AND rp.permission_name = $1 AND rp.is_enabled = true)
                   ELSE (r.role_code = ANY($2::text[]) OR u.user_id = ANY($3::bigint[])) END
          AND NOT EXISTS (
            SELECT 1 FROM unnest($4::text[]) AS need(permission_name)
             WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active = true
                                WHERE rp.role_id = u.role_id AND rp.permission_name = need.permission_name AND rp.is_enabled = true))
        ORDER BY u.user_id`,
      [filter.byPermission, filter.roleCodes, filter.userIds, required],
    )).rows;
    const byRole = new Map<number, Awaited<ReturnType<typeof loadRoleAuthorizationWith>>>();
    const users: CurrentUser[] = [];
    for (const row of rows) {
      const roleId = Number(row.role_id);
      const role = mapRoleIdToRole(roleId);
      if (!role) continue;
      if (!byRole.has(roleId)) byRole.set(roleId, await loadRoleAuthorizationWith(this.database, roleId));
      const authorization = byRole.get(roleId)!;
      users.push({ id: row.user_id, username: row.username ?? row.user_id, role, roleId, permissions: authorization.permissions, policyScopes: authorization.scopes });
    }
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

  /**
   * Уведомление сервиса (§5.7 п.4): событие outbox с ключом идемпотентности и in_app-запись с ключом `${key}:in_app`
   * в одной транзакции; повтор с тем же ключом ничего не создаёт. Событие сразу «processed»: реле его не обрабатывает.
   */
  async writeServiceNotification(input: ServiceNotificationInput, guard?: ServiceRuleGuard): Promise<boolean> {
    return this.database.transaction(async (client: DatabaseClient) => {
      let balloonMode: BalloonMode | null = null;
      if (guard) {
        // Точка сериализации с PATCH правила (R1-4): FOR SHARE строки правила ДО вставок; выключено или получатели
        // сменились после выборки прогона — запись пропускается (следующий прогон выберет заново).
        const rule = (await client.query<{ is_enabled: boolean; recipients_hash: string; channels_json: unknown; balloon_mode: string | null }>(
          `SELECT is_enabled, md5(COALESCE(recipients_json, '{}'::jsonb)::text) AS recipients_hash, channels_json, balloon_mode
             FROM notification_rules WHERE rule_code = $1 FOR SHARE`,
          [guard.ruleCode],
        )).rows[0];
        if (!rule || rule.is_enabled !== true || rule.recipients_hash !== guard.recipientsHash) return false;
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
