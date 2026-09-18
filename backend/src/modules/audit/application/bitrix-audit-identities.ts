export const BITRIX_REQUEST_ORDER_SQL = `(SELECT r.linked_order_id FROM bitrix24_incoming_request r WHERE audit_log.entity_type='bitrix24_incoming_request' AND r.request_id::text=audit_log.entity_id)`;
const requestDeal = `(SELECT r.bitrix_deal_id FROM bitrix24_incoming_request r WHERE audit_log.entity_type='bitrix24_incoming_request' AND r.request_id::text=audit_log.entity_id)`;
export const BITRIX_OBJECT_IDS_SQL = Object.fromEntries(
  ['contact', 'company', 'deal', 'payment'].map((type) => {
    const primary = `CASE WHEN audit_log.metadata_json->>'bitrixObject'='${type}' THEN audit_log.metadata_json->>'bitrixId' END`;
    const key =
      type === 'deal'
        ? 'bitrixDealId'
        : type === 'payment'
        ? 'bitrixPaymentId'
        : null;
    const snapshot = key
      ? `COALESCE(audit_log.metadata_json->>'${key}', audit_log.after_json->>'${key}', ${primary})`
      : primary;
    return [
      type,
      {
        snapshot,
        id:
          type === 'deal' ? `COALESCE(${snapshot}, ${requestDeal})` : snapshot,
      },
    ];
  })
);

// Current request links are clearly labelled, never written back to immutable history.
export const BITRIX_REFS_SQL = `(SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM jsonb_array_elements(jsonb_build_array(${Object.entries(
  BITRIX_OBJECT_IDS_SQL
)
  .map(
    ([type, expr]) =>
      `jsonb_build_object('type','${type}','id',${expr.id},'identitySource',CASE WHEN ${expr.snapshot} IS NOT NULL THEN 'event' ELSE 'current_request' END)`
  )
  .join(',')})) ref WHERE ref->>'id' ~ '^[1-9][0-9]{0,17}$')`;
