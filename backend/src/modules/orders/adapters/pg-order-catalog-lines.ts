import { randomUUID } from 'node:crypto';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { requireCatalogPermission } from '../../catalog/catalog.validation';
import { catalogLineAmount, catalogSubtotal, normalizeCatalogLineInputs, normalizeDeletedCatalogLineIds,
  type OrderCatalogLineDto, type OrderCatalogPlan, type EffectiveCatalogLine } from '../domain/order-catalog-lines';

export async function readOrderCatalogLines(db: DatabaseClient, orderId: number): Promise<OrderCatalogLineDto[]> {
  const result = await db.query<{ dto: OrderCatalogLineDto }>(`SELECT jsonb_build_object(
    'id',l.id,'catalogItemId',l.catalog_item_id,'catalogVersion',l.catalog_version,'lineNumber',l.line_number,
    'name',l.name,'sku',l.sku,'kind',l.kind,'unitId',l.unit_id,'unitName',l.unit_name,'refKey1c',l.ref_key_1c,
    'quantity',l.quantity::text,'unitPrice',l.unit_price::text,'amount',l.amount::text,'notes',l.notes,
    'catalogActive',c.is_active) AS dto FROM order_catalog_lines l JOIN catalog_items c ON c.id=l.catalog_item_id
    WHERE l.order_id=$1::bigint AND l.delete_flag=false ORDER BY l.line_number,l.id`, [orderId]);
  return result.rows.map(row => row.dto);
}

/** Caller owns order row lock, version, actor, order permissions and transaction. */
export async function prepareOrderCatalogLines(db: TransactionClient, orderId: number | null,
  input: unknown, deleted: unknown, user: CurrentUser): Promise<OrderCatalogPlan> {
  const lines = normalizeCatalogLineInputs(input) ?? [];
  const deletedIds = normalizeDeletedCatalogLineIds(deleted);
  const before = orderId === null ? [] : await readOrderCatalogLines(db, orderId);
  const byId = new Map(before.map(row => [row.id, row]));
  for (const id of deletedIds) {
    if (!byId.has(id) || lines.some(row => row.id === id)) {
      throw new ApiError(422, 'ORDER_CATALOG_LINE_OWNERSHIP', 'Удаляемая позиция не принадлежит заказу или одновременно изменяется');
    }
  }
  for (const row of lines) {
    if (row.id !== undefined && !byId.has(row.id)) {
      throw new ApiError(422, 'ORDER_CATALOG_LINE_OWNERSHIP', 'Позиция не принадлежит заказу или уже удалена');
    }
  }
  const selected = lines.filter(row => !row.id || byId.get(row.id)?.catalogItemId !== row.catalogItemId);
  const snapshots = new Map<number, Pick<OrderCatalogLineDto, 'name' | 'sku' | 'kind' | 'unitId' | 'unitName' | 'refKey1c' | 'catalogVersion' | 'catalogActive'>>();
  if (selected.length) {
    requireCatalogPermission(user);
    const ids = [...new Set(selected.map(row => row.catalogItemId))].sort((a, b) => a - b);
    const result = await db.query<{ id: string; name: string; sku: string | null; kind: OrderCatalogLineDto['kind'];
      unit_id: number; unit_name: string; ref_key_1c: string | null; version: number; is_active: boolean }>(
      `SELECT c.id,c.name,c.sku,c.kind,c.unit_id,coalesce(u.unit_name,u.unit_code) AS unit_name,c.ref_key_1c,c.version,c.is_active
       FROM catalog_items c JOIN units u ON u.unit_id=c.unit_id WHERE c.id=ANY($1::bigint[]) ORDER BY c.id FOR SHARE OF c,u`, [ids]);
    for (const row of result.rows) snapshots.set(Number(row.id), {
      name: row.name, sku: row.sku, kind: row.kind, unitId: row.unit_id, unitName: row.unit_name,
      refKey1c: row.ref_key_1c, catalogVersion: row.version, catalogActive: row.is_active,
    });
    for (const row of selected) {
      const snapshot = snapshots.get(row.catalogItemId);
      if (!snapshot?.catalogActive || snapshot.catalogVersion !== row.catalogVersion) {
        throw new ApiError(409, 'ORDER_CATALOG_CHANGED', 'Товар/услуга изменены или неактивны. Выберите актуальную позицию справочника');
      }
    }
  }
  const after: EffectiveCatalogLine[] = before.filter(row => !deletedIds.includes(row.id));
  const writes: EffectiveCatalogLine[] = [];
  let nextNumber = Math.max(0, ...before.map(row => row.lineNumber));
  for (const row of lines) {
    const previous = row.id ? byId.get(row.id) : undefined;
    const snapshot = previous?.catalogItemId === row.catalogItemId ? previous : snapshots.get(row.catalogItemId)!;
    const effective: EffectiveCatalogLine = { ...snapshot, ...row,
      catalogVersion: snapshot.catalogVersion, lineNumber: previous?.lineNumber ?? ++nextNumber,
      notes: row.notes ?? '', amount: catalogLineAmount(row.quantity, row.unitPrice) };
    const changed = !previous || previous.catalogItemId !== row.catalogItemId || Number(previous.quantity) !== Number(row.quantity)
      || previous.unitPrice !== row.unitPrice || previous.notes !== effective.notes;
    if (changed) writes.push(effective);
    if (previous) after.splice(after.findIndex(item => item.id === previous.id), 1, effective);
    else after.push(effective);
  }
  if (after.length > 1000) throw new ApiError(422, 'ORDER_CATALOG_LINES_LIMIT', 'В заказе допускается не более 1000 товаров/услуг');
  catalogSubtotal(after);
  const beforeAggregate = orderId === null ? null : (await db.query('SELECT version,total_amount,final_amount,paid_amount FROM orders WHERE order_id=$1::bigint', [orderId])).rows[0];
  return { before, after, writes, deletedIds, beforeAggregate };
}

/** Persist within the parent's command transaction. No independent version or retry key. */
export async function persistOrderCatalogLines(tx: TransactionClient, orderId: number, plan: OrderCatalogPlan,
  user: CurrentUser, requestId: string): Promise<void> {
  if (!plan.writes.length && !plan.deletedIds.length) return;
  await tx.query(`UPDATE order_catalog_lines SET delete_flag=true,edited_by=$2::bigint,updated_at=now()
    WHERE order_id=$1::bigint AND id=ANY($3::bigint[]) AND delete_flag=false`, [orderId, user.id, plan.deletedIds]);
  for (const row of plan.writes) {
    const args = [orderId, row.catalogItemId, row.lineNumber, row.name, row.sku, row.kind, row.unitId,
      row.unitName, row.catalogVersion, row.refKey1c, row.quantity, row.unitPrice, row.notes, user.id];
    if (row.id) {
      await tx.query(`UPDATE order_catalog_lines SET catalog_item_id=$2::bigint,line_number=$3::integer,name=$4::text,
        sku=$5::text,kind=$6::text,unit_id=$7::smallint,unit_name=$8::text,catalog_version=$9::integer,ref_key_1c=$10::uuid,
        quantity=$11::numeric,unit_price=$12::numeric,notes=$13::text,edited_by=$14::bigint,updated_at=now(),delete_flag=false
        WHERE order_id=$1::bigint AND id=$15::bigint`, [...args, row.id]);
    } else {
      const result = await tx.query<{ id: string }>(`INSERT INTO order_catalog_lines
        (order_id,catalog_item_id,line_number,name,sku,kind,unit_id,unit_name,catalog_version,ref_key_1c,quantity,unit_price,notes,created_by,edited_by)
        VALUES($1::bigint,$2::bigint,$3::integer,$4::text,$5::text,$6::text,$7::smallint,$8::text,$9::integer,$10::uuid,
          $11::numeric,$12::numeric,$13::text,$14::bigint,$14::bigint) RETURNING id`, args);
      row.id = Number(result.rows[0].id);
    }
  }
}

/** Call after parent totals/version are final, in the same transaction. */
export async function recordOrderCatalogLinesChange(tx: TransactionClient, orderId: number, plan: OrderCatalogPlan,
  user: CurrentUser, requestId: string): Promise<void> {
  if (!plan.writes.length && !plan.deletedIds.length) return;
  const aggregate = (await tx.query('SELECT version,total_amount,final_amount,paid_amount FROM orders WHERE order_id=$1::bigint', [orderId])).rows[0];
  const event = 'order.catalog_lines_changed';
  const before = { catalogLines: plan.before, catalogSubtotal: catalogSubtotal(plan.before), aggregate: plan.beforeAggregate ?? null };
  const after = { catalogLines: await readOrderCatalogLines(tx, orderId), catalogSubtotal: catalogSubtotal(plan.after), aggregate };
  const relatedIds = [...new Set([...plan.before, ...plan.after].map(row => row.catalogItemId))];
  await auditService.record(tx, { event, entityType: 'order', entityId: orderId, relatedOrderId: orderId,
    actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId, source: 'erp',
    before, after, diff: computeDiff(before, after), relatedEntities: relatedIds.map(id => ({ entityType: 'catalog_item', entityId: id })) });
  const eventId = randomUUID();
  await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
    VALUES($1::text,'order',$2::text,$3::jsonb,$4::text)`, [event, String(orderId), JSON.stringify({
    eventId, eventType: event, orderId, actorUserId: user.id, requestId, source: 'erp',
    changedLineIds: plan.writes.map(row => row.id), deletedLineIds: plan.deletedIds, catalogItemIds: relatedIds,
    catalogSubtotal: after.catalogSubtotal,
    version: aggregate.version, totalAmount: aggregate.total_amount, finalAmount: aggregate.final_amount,
  }), `${event}:${eventId}`]);
}
