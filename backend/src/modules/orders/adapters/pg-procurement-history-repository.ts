import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type {
  ProcurementHistoryCurrentDto,
  ProcurementHistoryQuery,
  ProcurementHistoryResponseDto,
} from '../application/procurement-history.types';
import {
  encodeHistoryCursor,
  mapHistoryRow,
  nestedLineOrderIds,
  ORDER_RESOURCE_HISTORY_EVENTS,
  SUPPLIER_REQUEST_HISTORY_EVENTS,
  type ProcurementHistoryRow,
} from '../domain/procurement-history';
import { parseResourceKey, PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';

/**
 * История закупа материала заказа (план 2026-09-28 §5.6). Scope заказа — тем же чтением, что и карточка
 * потребности (404 вне scope / в корзине); события — из audit_log по нормализованным измерениям: распределения
 * и отметки — `related_order_id` + `resourceKey`, заявки — заказ и материал в снимке строк до/после изменения.
 */
export class PgProcurementHistoryRepository {
  constructor(private readonly database: DatabaseService) {}

  async getHistory(query: ProcurementHistoryQuery, options: { canSeeAmounts: boolean }): Promise<ProcurementHistoryResponseDto> {
    if (!parseResourceKey(query.resourceKey)) {
      throw new ApiError(422, 'PROCUREMENT_HISTORY_QUERY_INVALID', 'Некорректный материал', { field: 'resourceKey' });
    }
    const card = await new PgOrderResourceDemandRepository(this.database).getCard(
      { currentUser: query.currentUser, orderId: query.orderId },
      { procurementEnabled: true, canSeeAmounts: options.canSeeAmounts },
    );
    const line = card.data.lines.find((entry) => entry.resourceKey === query.resourceKey);
    const current: ProcurementHistoryCurrentDto | null = line ? {
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      purchased: line.procurement.purchased,
      origin: line.procurement.origin,
      markedAt: line.procurement.markedAt,
      quantityAtMark: line.procurement.quantityAtMark,
      unitAtMark: line.procurement.unitAtMark,
      changedSinceMark: line.procurement.changedSinceMark,
      orphan: line.orphan,
    } : null;

    const params: unknown[] = [query.orderId, query.resourceKey, ORDER_RESOURCE_HISTORY_EVENTS, SUPPLIER_REQUEST_HISTORY_EVENTS];
    let cursorSql = '';
    if (query.before) {
      const atIndex = params.push(query.before.at);
      const idIndex = params.push(query.before.id);
      cursorSql = `AND (a.created_at, a.audit_id) < ($${atIndex}::timestamptz, $${idIndex}::uuid)`;
    }
    const limitIndex = params.push(query.limit + 1);
    // Заказ и материал в строке заявки — включением в снимок до/после (заказ мог быть убран из заявки правкой).
    const requestMatch = `jsonb_build_array(jsonb_build_object('resourceKey', $2::text, 'orders', jsonb_build_array(jsonb_build_object('orderId', $1::bigint))))`;
    const { rows } = await this.database.query<ProcurementHistoryRow>(
      `WITH picked AS (
         SELECT a.audit_id FROM audit_log a
          WHERE a.event = ANY($3::text[]) AND a.related_order_id = $1 AND a.metadata_json->>'resourceKey' = $2 ${cursorSql}
         UNION
         SELECT a.audit_id FROM audit_log a
           JOIN audit_log_related_entity r ON r.audit_id = a.audit_id AND r.entity_type = 'order' AND r.entity_id = $1
          WHERE a.event = ANY($4::text[]) ${cursorSql}
            AND (a.after_json->'lines' @> ${requestMatch} OR a.before_json->'lines' @> ${requestMatch})
       )
       SELECT a.audit_id::text AS audit_id, a.created_at,
              to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
              a.event, COALESCE(NULLIF(btrim(u.full_name), ''), u.username::text, a.username) AS actor_name,
              a.metadata_json, a.diff_json, a.after_json,
              al.unit_code AS allocation_unit, srl.unit_code AS link_unit,
              d.onec_document_id AS doc_id, d.doc_kind, d.number AS doc_number, d.doc_date
         FROM picked p
         JOIN audit_log a ON a.audit_id = p.audit_id
         LEFT JOIN users u ON u.user_id = a.user_id
         LEFT JOIN order_resource_onec_allocations al
           ON a.entity_type = 'order_resource_onec_allocation' AND al.allocation_id = a.entity_id::bigint
         LEFT JOIN supplier_request_line_orders srlo
           ON srlo.supplier_request_line_order_id = (a.metadata_json->>'supplierRequestLineOrderId')::bigint
         LEFT JOIN supplier_request_lines srl ON srl.supplier_request_line_id = srlo.supplier_request_line_id
         LEFT JOIN onec_documents d ON d.onec_document_id = (a.metadata_json->>'onecDocumentId')::bigint
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT $${limitIndex}`,
      params,
    );
    const page = rows.slice(0, query.limit);
    // Номера заявок и единицы строк для связей, вложенных в события распределений (CR1-2) — одним запросом.
    const lineOrderIds = nestedLineOrderIds(page);
    const lineOrders = new Map<number, { number: string | null; unit: string | null }>();
    if (lineOrderIds.length > 0) {
      const refs = await this.database.query<{ id: string; request_number: string | null; unit_code: string | null }>(
        `SELECT lo.supplier_request_line_order_id::text AS id, r.request_number, l.unit_code
           FROM supplier_request_line_orders lo
           JOIN supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
           JOIN supplier_requests r ON r.supplier_request_id = l.supplier_request_id
          WHERE lo.supplier_request_line_order_id = ANY($1::bigint[])`,
        [lineOrderIds],
      );
      for (const ref of refs.rows) lineOrders.set(Number(ref.id), { number: ref.request_number, unit: ref.unit_code });
    }
    const context = { orderId: query.orderId, resourceKey: query.resourceKey, canSeeAmounts: options.canSeeAmounts, lineOrders };
    const events = page.map((row) => mapHistoryRow(row, context)).filter((event) => event !== null);
    const last = page.at(-1);
    return {
      orderId: query.orderId,
      resourceKey: query.resourceKey,
      current,
      events,
      nextCursor: rows.length > query.limit && last ? encodeHistoryCursor(last.cursor_at, last.audit_id) : null,
    };
  }
}
