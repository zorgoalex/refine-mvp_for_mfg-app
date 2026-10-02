/**
 * Действует ли распределение документа 1С для итогов закупа (согласовано с сессией 1С, 2026-10-02): документ проведён,
 * не помечен на удаление, есть в выгрузке 1С (`missing_in_source_at IS NULL` — в т.ч. «сменил вид операции», путь
 * missing_in_source), строка не удалена в 1С. Строка с конфликтом загрузки (`load_conflict_code`) ДЕЙСТВУЕТ: загрузчик
 * держит прежние применённые значения, пока конфликт не разобран. Недействующие связи остаются в списках со статусом.
 */
export type OnecDocumentState = 'active' | 'conflict' | 'kind_changed' | 'missing' | 'deleted' | 'unposted' | 'line_removed';

/** SQL-предикат «распределение действует» (алиасы документа и строки). */
export function onecLiveSql(doc = 'd', line = 'l'): string {
  return `(${doc}.posted AND NOT ${doc}.deleted_in_onec AND ${doc}.missing_in_source_at IS NULL AND ${line}.removed_in_onec_at IS NULL)`;
}

/** SQL-выражение состояния (порядок — от причины, которую важнее показать). */
export function onecStateSql(doc = 'd', line = 'l'): string {
  return `CASE
      WHEN ${doc}.missing_in_source_at IS NOT NULL AND ${doc}.load_conflict->>'kindChangedTo' IS NOT NULL THEN 'kind_changed'
      WHEN ${doc}.missing_in_source_at IS NOT NULL THEN 'missing'
      WHEN ${doc}.deleted_in_onec THEN 'deleted'
      WHEN NOT ${doc}.posted THEN 'unposted'
      WHEN ${line}.removed_in_onec_at IS NOT NULL THEN 'line_removed'
      WHEN ${line}.load_conflict_code IS NOT NULL THEN 'conflict'
      ELSE 'active' END`;
}

/** Учитывается ли связь в итогах (пришло / оплачено / заказано). */
export function isCountableState(state: OnecDocumentState): boolean {
  return state === 'active' || state === 'conflict';
}

/** «Пришло» по заказу строки заявки — сумма приходных связей только действующих документов 1С (алиас строки `lo`). */
export const FULFILLED_SQL = `(SELECT COALESCE(sum(k.quantity), 0)
               FROM order_resource_allocation_request_links k
               JOIN order_resource_onec_allocations fa ON fa.allocation_id = k.allocation_id
               JOIN onec_document_lines fl ON fl.onec_document_line_id = fa.onec_document_line_id
               JOIN onec_documents fd ON fd.onec_document_id = fl.onec_document_id
              WHERE k.supplier_request_line_order_id = lo.supplier_request_line_order_id
                AND k.removed_at IS NULL AND k.quantity IS NOT NULL AND ${onecLiveSql('fd', 'fl')})`;

/**
 * Занято связями (лимит привязки, CR1-1): ВСЕ неснятые приходные связи заказа строки заявки, как в ограничении БД
 * (триггер 215: Σ активных связей ≤ заказано) — недействующие тоже, пока их не отвяжут. Для подбора и «возможных
 * совпадений»: предлагать больше, чем остаётся под лимитом, нельзя (алиас строки `lo`).
 */
export const LINKED_SQL = `(SELECT COALESCE(sum(k.quantity), 0)
               FROM order_resource_allocation_request_links k
              WHERE k.supplier_request_line_order_id = lo.supplier_request_line_order_id
                AND k.removed_at IS NULL AND k.quantity IS NOT NULL)`;
