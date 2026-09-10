import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import { computeDiff } from '../../common/audit/audit-diff';
import type { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { parseCatalogId, parseCommandKey, parseItem, parseList, requireCatalogPermission, type CatalogInput } from './catalog.validation';

export interface CatalogItem extends CatalogInput {
  id: number; version: number; currency: 'KZT';
  unitName: string; unitSymbol: string | null;
  createdAt: string; updatedAt: string;
  refKey1c: string | null; sortOrder: number;
  createdBy: string; editedBy: string; createdByName: string; editedByName: string;
}
interface ItemRow extends QueryResultRow { dto: CatalogItem }
const itemProjection = `jsonb_build_object('id',c.id,'name',c.name,'sku',c.sku,'kind',c.kind,'unitId',c.unit_id,
  'basePrice',c.base_price::text,'currency',c.currency,'description',c.description,'isActive',c.is_active,
  'version',c.version,'unitName',coalesce(u.unit_name,u.unit_code),'unitSymbol',u.unit_symbol,
  'createdAt',c.created_at,'updatedAt',c.updated_at,'refKey1c',c.ref_key_1c,'sortOrder',c.sort_order,
  'createdBy',c.created_by::text,'editedBy',c.edited_by::text,
  'createdByName',(SELECT coalesce(nullif(btrim(a.full_name),''),a.username) FROM users a WHERE a.user_id=c.created_by),
  'editedByName',(SELECT coalesce(nullif(btrim(a.full_name),''),a.username) FROM users a WHERE a.user_id=c.edited_by)) AS dto`;

export class CatalogService {
  constructor(private readonly database: DatabaseService) {}

  async units(user: CurrentUser) {
    requireCatalogPermission(user);
    return (await this.database.query(`SELECT unit_id AS id,coalesce(unit_name,unit_code) AS name,
      unit_code AS code,unit_symbol AS symbol FROM units ORDER BY coalesce(unit_name,unit_code),unit_id`)).rows;
  }

  async list(user: CurrentUser, rawQuery: unknown) {
    requireCatalogPermission(user);
    const query = parseList(rawQuery);
    const pattern = '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%';
    // One SQL snapshot: total stays correct even on an empty/out-of-range page.
    const result = await this.database.query<{ items: CatalogItem[]; total: number }>(`WITH filtered AS (
      SELECT c.*,coalesce(u.unit_name,u.unit_code) AS unit_name,u.unit_symbol FROM catalog_items c JOIN units u USING(unit_id)
      WHERE ($1::boolean IS NULL OR c.is_active=$1::boolean) AND ($2::text IS NULL OR c.kind=$2::text)
      AND (c.name ILIKE $3 ESCAPE E'\\\\' OR coalesce(c.sku,'') ILIKE $3 ESCAPE E'\\\\' OR coalesce(c.ref_key_1c::text,'') ILIKE $3 ESCAPE E'\\\\')
    ), page AS (SELECT * FROM filtered ORDER BY sort_order,name,id LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(dto ORDER BY sort_order,name,id)
      FROM (SELECT c.sort_order,c.name,c.id,${itemProjection} FROM page c JOIN units u USING(unit_id)) rows),'[]'::jsonb) AS items`,
    [query.active === 'all' ? null : query.active === 'true', query.kind ?? null, pattern, query.limit, query.offset]);
    return result.rows[0];
  }

  async get(user: CurrentUser, id: number): Promise<CatalogItem> {
    requireCatalogPermission(user);
    parseCatalogId(String(id));
    return this.read(this.database, id);
  }

  private async read(db: DatabaseClient, id: number): Promise<CatalogItem> {
    const row = (await db.query<ItemRow>(`SELECT ${itemProjection} FROM catalog_items c JOIN units u USING(unit_id) WHERE c.id=$1`, [id])).rows[0];
    if (!row) throw new ApiError(404, 'CATALOG_NOT_FOUND', 'Товар или услуга не найдены');
    return row.dto;
  }

  async save(user: CurrentUser, raw: unknown, rawKey: unknown, requestId: string, id?: number): Promise<CatalogItem> {
    requireCatalogPermission(user, true);
    const key = parseCommandKey(rawKey);
    const { expectedVersion, ...input } = parseItem(raw, id !== undefined);
    if (id !== undefined) parseCatalogId(String(id));
    const actorId = parseCatalogId(user.id);
    const hash = createHash('sha256').update(JSON.stringify({ actorId, id: id ?? null, expectedVersion: expectedVersion ?? null, input })).digest('hex');
    try {
      return await this.database.transaction(async tx => {
        // Namespace prevents unrelated modules accidentally sharing a command lock.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', ['catalog:' + key]);
        const actor = (await tx.query<{ username: string }>(`SELECT username FROM users WHERE user_id=$1 AND is_active=true
          AND is_service_account=false FOR SHARE`, [actorId])).rows[0];
        if (!actor) throw new ApiError(403, 'CATALOG_ACTOR_INVALID', 'Сохранение доступно только активному пользователю ERP');
        const receipt = (await tx.query<{ request_hash: string; response_json: CatalogItem }>(
          'SELECT request_hash,response_json FROM catalog_item_commands WHERE idempotency_key=$1', [key])).rows[0];
        if (receipt) {
          if (receipt.request_hash !== hash) throw new ApiError(409, 'CATALOG_KEY_CONFLICT', 'Ключ сохранения уже использован для другой команды');
          return receipt.response_json;
        }
        let before: CatalogItem | null = null;
        if (id !== undefined) {
          const locked = await tx.query('SELECT id FROM catalog_items WHERE id=$1 FOR UPDATE', [id]);
          if (!locked.rows[0]) throw new ApiError(404, 'CATALOG_NOT_FOUND', 'Товар или услуга не найдены');
          before = await this.read(tx, id);
          if (before.version !== expectedVersion) throw new ApiError(409, 'CATALOG_VERSION_CONFLICT', 'Запись уже изменена. Загрузите актуальную версию', { currentVersion: before.version });
        }
        const unit = await tx.query('SELECT unit_id FROM units WHERE unit_id=$1 FOR KEY SHARE', [input.unitId]);
        if (!unit.rows[0]) throw new ApiError(422, 'CATALOG_UNIT_NOT_FOUND', 'Выбранная единица измерения не найдена');
        const changed = !before || Object.entries(input).some(([field, value]) => before![field as keyof CatalogInput] !== value);
        let after = before;
        if (changed) {
          // Omission preserves fields during rolling upgrades; hash above stays compatible with old receipts.
          const values = [input.name, input.sku, input.kind, input.unitId, input.basePrice, input.description, input.isActive, actorId,
            input.refKey1c === undefined ? before?.refKey1c ?? null : input.refKey1c,
            input.sortOrder ?? before?.sortOrder ?? 100];
          const result = id === undefined
            ? await tx.query<{ id: string }>(`INSERT INTO catalog_items(name,sku,kind,unit_id,base_price,description,is_active,created_by,edited_by,ref_key_1c,sort_order)
                VALUES($1,$2,$3,$4,$5::numeric,$6,$7,$8::bigint,$8::bigint,$9::uuid,$10::smallint) RETURNING id`, values)
            : await tx.query<{ id: string }>(`UPDATE catalog_items SET name=$1,sku=$2,kind=$3,unit_id=$4,base_price=$5::numeric,
                description=$6,is_active=$7,edited_by=$8::bigint,ref_key_1c=$9::uuid,sort_order=$10::smallint,
                version=version+1,updated_at=now() WHERE id=$11 RETURNING id`, [...values, id]);
          after = await this.read(tx, Number(result.rows[0].id));
          const event = !before ? 'catalog.item_created' : before.isActive === after.isActive ? 'catalog.item_updated'
            : after.isActive ? 'catalog.item_restored' : 'catalog.item_archived';
          const beforeJson = before ? { ...before } : null;
          const afterJson = { ...after };
          await auditService.record(tx, { event, entityType: 'catalog_item', entityId: after.id,
            actorUserId: actorId, actorUsername: actor.username, actorRole: user.role, requestId, source: 'backend-catalog',
            before: beforeJson, after: afterJson, diff: computeDiff(beforeJson, afterJson),
            relatedEntities: [{ entityType: 'catalog_item', entityId: after.id }, { entityType: 'unit', entityId: after.unitId }],
          });
          await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
            VALUES($1,'catalog_item',$2,$3::jsonb,$4)`, [event, String(after.id), JSON.stringify({
            eventId: randomUUID(), eventType: event, actorUserId: actorId, requestId, itemId: after.id, version: after.version,
          }), 'catalog:' + key]);
        }
        if (!after) throw new Error('Catalog command did not produce a result');
        await tx.query(`INSERT INTO catalog_item_commands(idempotency_key,request_hash,actor_user_id,response_json)
          VALUES($1,$2,$3,$4::jsonb)`, [key, hash, actorId, JSON.stringify(after)]);
        return after;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'catalog_items_ref_key_1c_unique') {
        throw new ApiError(409, 'CATALOG_1C_KEY_CONFLICT', 'Этот 1C_key уже используется, включая архивные записи');
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'catalog_items_sku_unique') {
        throw new ApiError(409, 'CATALOG_SKU_CONFLICT', 'Этот артикул уже используется, включая архивные записи');
      }
      throw error;
    }
  }
}
