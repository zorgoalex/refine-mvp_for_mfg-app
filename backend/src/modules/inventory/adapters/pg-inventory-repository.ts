import { createHash, randomUUID } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import type { AuditRelatedEntity } from '../../../common/audit/audit-event.types';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { analyzeFilmName } from '../../films/domain/film-name-normalizer';
import {
  buildScopedOrderWhere,
  loadProjectedOrders,
  ORDER_SELECT_SQL,
  type ResourceDemandOrderRow,
} from '../../orders/adapters/pg-order-resource-demand-repository';
import type {
  BalancesFilter,
  CommandContext,
  CreateImportDocumentInput,
  CreateManualDocumentInput,
  DocumentsFilter,
  OrderFilmStockItemDto,
  StockBalanceDto,
  StockDocKind,
  StockDocStatus,
  StockDocumentDto,
  StockDocumentLineDto,
  StockDocumentSummaryDto,
  UpdateLineInput,
} from '../application/inventory.types';
import {
  aliasKey,
  matchStockRow,
  normalizeAliasPart,
  prepareCandidates,
  type StockFilmCandidate,
} from '../domain/stock-import-matching';
import {
  aggregateLines,
  findUnresolvedLines,
  fromCents,
  negativeAfter,
  parseNameWithQuantity,
  parseQuantityCell,
  planMovements,
  toCents,
  type LineMatchStatus,
  type LineQuantityStatus,
  type StockDocType,
  type StockLineState,
} from '../domain/stock-posting';

export const SOURCE = 'erp_ui';

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown): string | null => (value === null || value === undefined ? null
  : value instanceof Date ? value.toISOString() : String(value));
const dateOnly = (value: unknown): string => (value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10));

function notFound(): ApiError {
  return new ApiError(404, 'STOCK_DOCUMENT_NOT_FOUND', 'Складской документ не найден');
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ---------------------------------------------------------------- идемпотентность

export async function beginIdempotent(
  tx: TransactionClient,
  input: { key: string; command: string; actorId: string; entityType: string; entityId: string; hash: string },
): Promise<unknown | undefined> {
  const inserted = await tx.query(
    `INSERT INTO command_idempotency_keys
       (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [input.key, input.command, input.actorId, input.entityType, input.entityId, input.hash],
  );
  if (inserted.rows.length > 0) return undefined;
  const existing = await tx.query<{ command_name: string; actor_user_id: string | null; entity_type: string; entity_id: string; request_hash: string; status: string; response_json: unknown }>(
    'SELECT command_name, actor_user_id, entity_type, entity_id, request_hash, status, response_json FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE',
    [input.key],
  );
  const row = existing.rows[0];
  if (!row || row.command_name !== input.command || String(row.actor_user_id) !== String(input.actorId)
    || row.entity_type !== input.entityType || row.entity_id !== input.entityId || row.request_hash !== input.hash) {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key уже использован для другого запроса');
  }
  if (row.status === 'completed') return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Запрос с этим Idempotency-Key ещё выполняется');
}

/** entity_id не меняется: повтор сверяет его с исходным значением (для создания — 'new'). */
export async function completeIdempotent(tx: TransactionClient, key: string, _entityId: string, response: unknown): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys
        SET status = 'completed', response_json = $2::jsonb, completed_at = now()
      WHERE idempotency_key = $1`,
    [key, JSON.stringify(response)],
  );
}

// ---------------------------------------------------------------- видимость заказа

function canViewOrders(user: CurrentUser): boolean {
  return user.permissions.includes('orders.view');
}

async function assertOrderVisible(client: DatabaseClient, user: CurrentUser, orderId: number): Promise<{ orderName: string | null }> {
  if (!canViewOrders(user)) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
  const { whereSql, params } = buildScopedOrderWhere(user, orderId);
  const result = await client.query<{ order_name: string | null }>(
    `SELECT o.order_name FROM orders o WHERE ${whereSql}`,
    params,
  );
  if (result.rows.length === 0) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
  return { orderName: result.rows[0].order_name };
}

/** Повтор по Idempotency-Key не должен обходить текущую видимость связанного заказа. */
export async function assertReplayVisible(client: DatabaseClient, user: CurrentUser, replay: unknown): Promise<StockDocumentDto> {
  const dto = replay as StockDocumentDto;
  if (dto && dto.orderId !== null && dto.orderId !== undefined) {
    try {
      await assertOrderVisible(client, user, dto.orderId);
    } catch {
      throw notFound();
    }
  }
  return dto;
}

/** SQL-предикат видимости документа: без заказа — всем с inventory.view; с заказом — по scope `orders.view`. */
function documentVisibilitySql(user: CurrentUser, params: unknown[], alias = 'd'): string {
  if (!canViewOrders(user)) return `${alias}.order_id IS NULL`;
  const { whereSql } = buildScopedOrderWhere(user, undefined, params);
  return `(${alias}.order_id IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.order_id = ${alias}.order_id AND ${whereSql}))`;
}

// ---------------------------------------------------------------- плёнки

interface FilmLockRow { film_id: string | number; canonical_film_id: string | number | null; is_active: boolean; film_name: string }

/** FOR SHARE по возрастанию; каждая плёнка обязана быть канонической и активной. */
async function lockCanonicalFilms(tx: TransactionClient, filmIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(filmIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  const rows = await tx.query<FilmLockRow>(
    `SELECT film_id, canonical_film_id, is_active, film_name FROM films
      WHERE film_id = ANY($1::bigint[]) ORDER BY film_id FOR SHARE`,
    [ids],
  );
  const byId = new Map(rows.rows.map((row) => [num(row.film_id), row]));
  const bad = ids.filter((id) => {
    const row = byId.get(id);
    return !row || row.canonical_film_id !== null || row.is_active !== true;
  });
  if (bad.length > 0) {
    throw new ApiError(422, 'STOCK_FILM_NOT_CANONICAL', 'Плёнка объединена с другой или неактивна — выберите плёнку заново', { filmIds: bad });
  }
  return new Map(rows.rows.map((row) => [num(row.film_id), row.film_name]));
}

async function loadStockCandidates(client: DatabaseClient): Promise<StockFilmCandidate[]> {
  const rows = await client.query<{ canonical_id: string; canonical_name: string; vendor_id: number | null; match_name: string }>(
    `WITH canon AS (
       SELECT film_id, film_name, vendor_id FROM films WHERE canonical_film_id IS NULL AND is_active = true
     )
     SELECT c.film_id AS canonical_id, c.film_name AS canonical_name, c.vendor_id, c.film_name AS match_name FROM canon c
     UNION ALL
     SELECT c.film_id, c.film_name, c.vendor_id, d.film_name FROM films d JOIN canon c ON c.film_id = d.canonical_film_id
     UNION ALL
     SELECT c.film_id, c.film_name, c.vendor_id, h.old_name
       FROM film_name_history h
       JOIN films f ON f.film_id = h.film_id
       JOIN canon c ON c.film_id = COALESCE(f.canonical_film_id, f.film_id)`,
  );
  return rows.rows.map((row) => ({
    canonicalFilmId: num(row.canonical_id),
    canonicalName: row.canonical_name,
    vendorId: numOrNull(row.vendor_id),
    matchName: row.match_name,
  }));
}

async function loadVendorResolver(client: DatabaseClient): Promise<(supplier: string) => number | null> {
  const vendors = await client.query<{ vendor_id: number; vendor_name: string }>('SELECT vendor_id, vendor_name FROM vendors');
  const aliases = await client.query<{ source_norm: string; vendor_id: number }>('SELECT source_norm, vendor_id FROM vendor_import_aliases');
  const byName = new Map(vendors.rows.map((row) => [normalizeAliasPart(row.vendor_name), Number(row.vendor_id)]));
  const byAlias = new Map(aliases.rows.map((row) => [row.source_norm, Number(row.vendor_id)]));
  return (supplier: string) => {
    const norm = normalizeAliasPart(supplier);
    if (!norm) return null;
    const direct = byAlias.get(norm) ?? byName.get(norm);
    if (direct !== undefined) return direct;
    const key = analyzeFilmName(supplier).vendorKey;
    return key && !key.startsWith('@') ? byName.get(normalizeAliasPart(key)) ?? null : null;
  };
}

/** Поставщики-заглушки («нд» и т. п.): у их плёнок поставщик вписан в название. */
export const PLACEHOLDER_VENDOR_NAMES = ['нд', 'н/д', 'н.д.', 'нет данных', 'не указан', '-'];

async function loadPlaceholderVendorIds(client: DatabaseClient): Promise<Set<number>> {
  const rows = await client.query<{ vendor_id: number }>(
    'SELECT vendor_id FROM vendors WHERE lower(btrim(vendor_name)) = ANY($1::text[])',
    [PLACEHOLDER_VENDOR_NAMES],
  );
  return new Set(rows.rows.map((row) => Number(row.vendor_id)));
}

// ---------------------------------------------------------------- чтение документа

interface DocumentRow {
  document_id: string; doc_type: StockDocKind; status: StockDocStatus; warehouse_id: number; doc_date: unknown;
  source: 'manual' | 'import' | 'onec'; order_id: string | null; order_name: string | null; file_name: string | null;
  comment: string | null; version: number; created_at: unknown; created_by_name: string | null;
  posted_at: unknown; posted_by_name: string | null; lines_count: string; total_quantity: string | null;
  counted_at: unknown; onec_document_id: string | null; onec_ref_key: string | null; onec_revision: number | null;
  projection_seq: number | null;
}

const DOCUMENT_SELECT = `
  SELECT d.document_id, d.doc_type, d.status, d.warehouse_id, d.doc_date, d.source, d.order_id,
         o_ref.order_name, d.file_name, d.comment, d.version, d.created_at, d.posted_at,
         d.counted_at, d.onec_document_id, d.onec_ref_key::text AS onec_ref_key, d.onec_revision, d.projection_seq,
         COALESCE(cu.full_name, cu.username) AS created_by_name,
         COALESCE(pu.full_name, pu.username) AS posted_by_name,
         -- Документ проекции 1С строк не имеет: количество и сумма — по его движениям (дельты со знаком).
         CASE WHEN d.source = 'onec'
           THEN (SELECT count(*) FROM stock_movements m WHERE m.document_id = d.document_id)
           ELSE (SELECT count(*) FROM stock_document_lines l WHERE l.document_id = d.document_id AND l.match_status <> 'skipped') END AS lines_count,
         CASE WHEN d.source = 'onec'
           THEN (SELECT COALESCE(sum(m.delta), 0) FROM stock_movements m WHERE m.document_id = d.document_id)
           ELSE (SELECT COALESCE(sum(l.quantity), 0) FROM stock_document_lines l WHERE l.document_id = d.document_id AND l.match_status <> 'skipped') END AS total_quantity
    FROM stock_documents d
    LEFT JOIN orders o_ref ON o_ref.order_id = d.order_id
    LEFT JOIN users cu ON cu.user_id = d.created_by
    LEFT JOIN users pu ON pu.user_id = d.posted_by`;

function toSummary(row: DocumentRow): StockDocumentSummaryDto {
  return {
    documentId: num(row.document_id), docType: row.doc_type, status: row.status, warehouseId: num(row.warehouse_id),
    docDate: dateOnly(row.doc_date), source: row.source, orderId: numOrNull(row.order_id), orderName: row.order_name,
    fileName: row.file_name, comment: row.comment, linesCount: num(row.lines_count),
    totalQuantity: Number(row.total_quantity ?? 0), version: num(row.version),
    createdAt: iso(row.created_at) ?? '', createdByName: row.created_by_name,
    postedAt: iso(row.posted_at), postedByName: row.posted_by_name,
    countedAt: iso(row.counted_at),
    onec: row.onec_document_id === null ? null : {
      documentId: num(row.onec_document_id), refKey: row.onec_ref_key, revision: row.onec_revision, projectionSeq: row.projection_seq,
    },
  };
}

interface LineRow {
  line_id: string; line_no: number; raw_name: string | null; raw_supplier: string | null; raw_quantity: string | null;
  film_id: string | null; film_name: string | null; quantity: string | null; match_status: LineMatchStatus;
  quantity_status: LineQuantityStatus; suggestions: unknown; issue: string | null;
}

function lineState(row: LineRow): StockLineState {
  return {
    lineId: num(row.line_id), lineNo: num(row.line_no), filmId: numOrNull(row.film_id),
    quantity: row.quantity === null ? null : Number(row.quantity),
    matchStatus: row.match_status, quantityStatus: row.quantity_status,
  };
}

async function readDocument(client: DatabaseClient, user: CurrentUser, documentId: number): Promise<StockDocumentDto> {
  const params: unknown[] = [documentId];
  const visibility = documentVisibilitySql(user, params);
  const docs = await client.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.document_id = $1 AND ${visibility}`, params);
  const doc = docs.rows[0];
  if (!doc) throw notFound();
  const lines = await client.query<LineRow>(
    `SELECT l.line_id, l.line_no, l.raw_name, l.raw_supplier, l.raw_quantity, l.film_id, f.film_name, l.quantity,
            l.match_status, l.quantity_status, l.suggestions, l.issue
       FROM stock_document_lines l LEFT JOIN films f ON f.film_id = l.film_id
      WHERE l.document_id = $1 ORDER BY l.line_no`,
    [documentId],
  );
  const movements = await client.query<{ film_id: string; film_name: string; movement_type: string; delta: string; balance_before: string; balance_after: string }>(
    `SELECT m.film_id, f.film_name, m.movement_type, m.delta, m.balance_before, m.balance_after
       FROM stock_movements m JOIN films f ON f.film_id = m.film_id
      WHERE m.document_id = $1 ORDER BY m.film_id`,
    [documentId],
  );
  const states = lines.rows.map(lineState);
  const filmNames = new Map(lines.rows.filter((row) => row.film_id !== null).map((row) => [num(row.film_id), row.film_name ?? '']));
  let preview = new Map<number, { before: number; after: number }>();
  let negative: StockDocumentDto['negativeAfter'] = [];
  if (doc.status === 'posted') {
    preview = new Map(movements.rows.map((row) => [num(row.film_id), { before: Number(row.balance_before), after: Number(row.balance_after) }]));
  } else if (doc.status === 'draft' && doc.doc_type !== 'onec') {
    // Документы проекции 1С всегда проведены; черновики — только receipt/writeoff/inventory.
    const aggregated = aggregateLines(states.filter((state) => state.matchStatus !== 'skipped'));
    const ids = [...aggregated.keys()];
    const balances = ids.length === 0 ? new Map<number, number>() : new Map((await client.query<{ film_id: string; quantity: string }>(
      'SELECT film_id, quantity FROM stock_balances WHERE warehouse_id = $1 AND film_id = ANY($2::bigint[])',
      [doc.warehouse_id, ids],
    )).rows.map((row) => [num(row.film_id), toCents(Number(row.quantity))]));
    const planned = planMovements(doc.doc_type, aggregated, balances);
    preview = new Map(planned.map((movement) => [movement.filmId, { before: fromCents(movement.beforeCents), after: fromCents(movement.afterCents) }]));
    negative = negativeAfter(planned).map((item) => ({ ...item, filmName: filmNames.get(item.filmId) ?? '' }));
  }
  const lineDtos: StockDocumentLineDto[] = lines.rows.map((row) => {
    const filmId = numOrNull(row.film_id);
    const balance = filmId === null || row.match_status === 'skipped' ? undefined : preview.get(filmId);
    return {
      lineId: num(row.line_id), lineNo: num(row.line_no), rawName: row.raw_name, rawSupplier: row.raw_supplier,
      rawQuantity: row.raw_quantity, filmId, filmName: row.film_name, quantity: row.quantity === null ? null : Number(row.quantity),
      matchStatus: row.match_status, quantityStatus: row.quantity_status,
      suggestions: Array.isArray(row.suggestions) ? row.suggestions as StockDocumentLineDto['suggestions'] : [],
      issue: row.issue, balanceBefore: balance?.before ?? null, balanceAfter: balance?.after ?? null,
    };
  });
  const fileSha = await client.query<{ file_sha256: string | null }>('SELECT file_sha256 FROM stock_documents WHERE document_id = $1', [documentId]);
  const sha = fileSha.rows[0]?.file_sha256 ?? null;
  const previous = sha === null ? null : (await client.query<{ document_id: string }>(
    `SELECT document_id FROM stock_documents
      WHERE file_sha256 = $1 AND status = 'posted' AND document_id <> $2
      ORDER BY document_id DESC LIMIT 1`,
    [sha, documentId],
  )).rows[0];
  return {
    ...toSummary(doc),
    previousPostedDocumentId: previous ? num(previous.document_id) : null,
    lines: lineDtos,
    movements: movements.rows.map((row) => ({
      filmId: num(row.film_id), filmName: row.film_name, movementType: row.movement_type,
      delta: Number(row.delta), balanceBefore: Number(row.balance_before), balanceAfter: Number(row.balance_after),
    })),
    unresolved: doc.status === 'draft' ? findUnresolvedLines(states) : [],
    negativeAfter: negative,
  };
}

// ---------------------------------------------------------------- audit + outbox

async function recordDocumentAudit(
  tx: TransactionClient,
  input: {
    event: string; ctx: CommandContext; documentId: number; docType: StockDocType; warehouseId: number;
    orderId: number | null; statusCode: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
    metadata: Record<string, unknown>; filmIds?: number[]; lineId?: number;
  },
): Promise<void> {
  const related: AuditRelatedEntity[] = [
    { entityType: 'stock_document', entityId: input.documentId },
    { entityType: 'warehouse', entityId: input.warehouseId },
    ...(input.orderId !== null ? [{ entityType: 'order', entityId: input.orderId }] : []),
    ...(input.filmIds ?? []).map((filmId) => ({ entityType: 'film', entityId: filmId })),
  ];
  await auditService.record(tx, {
    event: input.event,
    entityType: input.lineId !== undefined ? 'stock_document_line' : 'stock_document',
    entityId: input.lineId ?? input.documentId,
    actorUserId: input.ctx.currentUser.id,
    actorUsername: input.ctx.currentUser.username ?? null,
    actorRole: input.ctx.currentUser.role ?? null,
    requestId: input.ctx.requestId,
    source: SOURCE,
    relatedOrderId: input.orderId,
    statusField: 'status',
    statusCode: input.statusCode,
    stageCode: input.docType,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: { ...input.metadata, documentId: input.documentId, warehouseId: input.warehouseId, docType: input.docType, correlationId: input.ctx.requestId, commandSource: SOURCE },
    relatedEntities: related,
  });
}

// ---------------------------------------------------------------- репозиторий

export class PgInventoryRepository {
  constructor(private readonly database: DatabaseService) {}

  async listBalances(filter: BalancesFilter): Promise<{ total: number; items: StockBalanceDto[]; totalQuantity: number }> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.warehouseId !== null) where.push(`b.warehouse_id = $${params.push(filter.warehouseId)}`);
    if (filter.vendorId !== null) where.push(`f.vendor_id = $${params.push(filter.vendorId)}`);
    if (filter.search) where.push(`f.film_name ILIKE $${params.push(`%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
    if (filter.nonZero) where.push('b.quantity <> 0');
    if (filter.negative) where.push('b.quantity < 0');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitIndex = params.push(filter.limit);
    const offsetIndex = params.push(filter.offset);
    const rows = await this.database.query<{ warehouse_id: number; film_id: string; film_name: string; vendor_id: number | null; vendor_name: string | null; quantity: string; last_movement_at: unknown; total: string; total_quantity: string }>(
      `SELECT b.warehouse_id, b.film_id, f.film_name, f.vendor_id, v.vendor_name, b.quantity, b.last_movement_at,
              count(*) OVER () AS total, sum(b.quantity) OVER () AS total_quantity
         FROM stock_balances b
         JOIN films f ON f.film_id = b.film_id
         LEFT JOIN vendors v ON v.vendor_id = f.vendor_id
         ${whereSql}
        ORDER BY f.film_name, b.film_id
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return {
      total: rows.rows.length ? num(rows.rows[0].total) : 0,
      totalQuantity: rows.rows.length ? Number(rows.rows[0].total_quantity) : 0,
      items: rows.rows.map((row) => ({
        warehouseId: num(row.warehouse_id), filmId: num(row.film_id), filmName: row.film_name,
        vendorId: numOrNull(row.vendor_id), vendorName: row.vendor_name, quantity: Number(row.quantity),
        lastMovementAt: iso(row.last_movement_at),
      })),
    };
  }

  async listDocuments(user: CurrentUser, filter: DocumentsFilter): Promise<{ total: number; items: StockDocumentSummaryDto[] }> {
    const params: unknown[] = [];
    const where: string[] = [documentVisibilitySql(user, params)];
    if (filter.type) where.push(`d.doc_type = $${params.push(filter.type)}`);
    if (filter.status) where.push(`d.status = $${params.push(filter.status)}`);
    if (filter.from) where.push(`d.doc_date >= $${params.push(filter.from)}::date`);
    if (filter.to) where.push(`d.doc_date <= $${params.push(filter.to)}::date`);
    if (filter.orderId !== null) where.push(`d.order_id = $${params.push(filter.orderId)}`);
    if (filter.filmId !== null) {
      // Документы расхода 1С строк не имеют — плёнка в их движениях.
      const film = `$${params.push(filter.filmId)}`;
      where.push(`(EXISTS (SELECT 1 FROM stock_document_lines fl WHERE fl.document_id = d.document_id AND fl.film_id = ${film})
        OR (d.source = 'onec' AND EXISTS (SELECT 1 FROM stock_movements fm WHERE fm.document_id = d.document_id AND fm.film_id = ${film})))`);
    }
    const limitIndex = params.push(filter.limit);
    const offsetIndex = params.push(filter.offset);
    const rows = await this.database.query<DocumentRow & { total: string }>(
      `SELECT * , count(*) OVER () AS total FROM (${DOCUMENT_SELECT} WHERE ${where.join(' AND ')}) q
        ORDER BY q.created_at DESC, q.document_id DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return { total: rows.rows.length ? num(rows.rows[0].total) : 0, items: rows.rows.map(toSummary) };
  }

  async getDocument(user: CurrentUser, documentId: number): Promise<StockDocumentDto> {
    return readDocument(this.database, user, documentId);
  }

  async createManual(ctx: CommandContext, input: CreateManualDocumentInput): Promise<StockDocumentDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.document.create', actorId: ctx.currentUser.id,
        entityType: 'stock_document', entityId: 'new', hash: requestHash(input),
      });
      if (replay !== undefined) return assertReplayVisible(tx, ctx.currentUser, replay);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await this.assertWarehouse(tx, input.warehouseId);
      if (input.orderId !== null) await assertOrderVisible(tx, ctx.currentUser, input.orderId);
      const names = await lockCanonicalFilms(tx, input.lines.map((line) => line.filmId));
      const documentId = await this.insertDocument(tx, ctx, {
        docType: input.docType, warehouseId: input.warehouseId, docDate: input.docDate, source: 'manual',
        orderId: input.orderId, comment: input.comment, fileName: null, fileSha256: null, sheetName: null,
        countedAt: input.countedAt ?? null,
      });
      let lineNo = 0;
      for (const line of input.lines) {
        lineNo += 1;
        await tx.query(
          `INSERT INTO stock_document_lines (document_id, line_no, film_id, quantity, match_status, quantity_status)
           VALUES ($1, $2, $3, $4, 'manual', 'confirmed')`,
          [documentId, lineNo, line.filmId, line.quantity],
        );
      }
      await recordDocumentAudit(tx, {
        event: 'inventory.document_created', ctx, documentId, docType: input.docType, warehouseId: input.warehouseId,
        orderId: input.orderId, statusCode: 'draft',
        after: { docType: input.docType, docDate: input.docDate, linesCount: input.lines.length },
        metadata: { docSource: 'manual', linesCount: input.lines.length, commentLength: input.comment?.length ?? 0 },
        filmIds: [...names.keys()],
      });
      if (input.post) {
        await this.postLocked(tx, ctx, documentId, input.allowNegative);
      }
      const dto = await readDocument(tx, ctx.currentUser, documentId);
      await completeIdempotent(tx, ctx.idempotencyKey, String(documentId), dto);
      return dto;
    });
  }

  async createImport(ctx: CommandContext, input: CreateImportDocumentInput): Promise<StockDocumentDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.import.create', actorId: ctx.currentUser.id,
        entityType: 'stock_document', entityId: 'new', hash: requestHash(input),
      });
      if (replay !== undefined) return assertReplayVisible(tx, ctx.currentUser, replay);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await this.assertWarehouse(tx, input.warehouseId);
      const aliases = await tx.query<{ source_name_norm: string; source_supplier_norm: string; film_id: string }>(
        'SELECT source_name_norm, source_supplier_norm, film_id FROM stock_import_aliases',
      );
      const aliasMap = new Map(aliases.rows.map((row) => [`${row.source_name_norm}|${row.source_supplier_norm}`, num(row.film_id)]));
      const prepared = prepareCandidates(await loadStockCandidates(tx));
      const vendorIdForSupplier = await loadVendorResolver(tx);
      const placeholderVendorIds = await loadPlaceholderVendorIds(tx);
      const documentId = await this.insertDocument(tx, ctx, {
        docType: input.docType, warehouseId: input.warehouseId, docDate: input.docDate, source: 'import',
        orderId: null, comment: null, fileName: input.fileName, fileSha256: input.fileSha256, sheetName: input.sheetName,
        countedAt: input.countedAt ?? null,
      });
      // Сопоставление в памяти, затем блокировка выбранных плёнок FOR SHARE (по возрастанию, §3.3) и
      // повторная проверка «канон и активна» под блокировкой — до сохранения ссылок в строках.
      const planned: Array<{ row: (typeof input.rows)[number]; parsed: ReturnType<typeof parseNameWithQuantity>; match: ReturnType<typeof matchStockRow> }> = [];
      for (const [position, row] of input.rows.entries()) {
        // Сопоставление синхронное: раз в 100 строк отдаём event loop (до 2000 строк ≈ секунды).
        if (position > 0 && position % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
        const hasQuantityColumn = row.quantity !== null && row.quantity !== undefined && String(row.quantity).trim() !== '';
        const parsed = hasQuantityColumn
          ? { name: row.name.replace(/\s+/g, ' ').trim(), ...parseQuantityCell(row.quantity) }
          : parseNameWithQuantity(row.name);
        const match = matchStockRow({ name: parsed.name, supplier: row.supplier ?? '' }, { aliases: aliasMap, vendorIdForSupplier, placeholderVendorIds, prepared });
        planned.push({ row, parsed, match });
      }
      const chosenIds = [...new Set(planned.flatMap((item) => (item.match.filmId === null ? [] : [item.match.filmId])))].sort((a, b) => a - b);
      const validIds = new Set<number>();
      if (chosenIds.length > 0) {
        const locked = await tx.query<FilmLockRow>(
          `SELECT film_id, canonical_film_id, is_active, film_name FROM films
            WHERE film_id = ANY($1::bigint[]) ORDER BY film_id FOR SHARE`,
          [chosenIds],
        );
        for (const row of locked.rows) {
          if (row.canonical_film_id === null && row.is_active === true) validIds.add(num(row.film_id));
        }
      }
      let lineNo = 0;
      const stats: Record<string, number> = {};
      for (const { row, parsed, match: rawMatch } of planned) {
        lineNo += 1;
        const stale = rawMatch.filmId !== null && !validIds.has(rawMatch.filmId);
        const match = stale ? { ...rawMatch, filmId: null, matchStatus: 'unmatched' as const } : rawMatch;
        const issue = stale
          ? [parsed.issue, 'Сохранённое сопоставление указывает на объединённую или неактивную плёнку — выберите заново'].filter(Boolean).join('; ')
          : parsed.issue;
        stats[match.matchStatus] = (stats[match.matchStatus] ?? 0) + 1;
        await tx.query(
          `INSERT INTO stock_document_lines
             (document_id, line_no, raw_name, raw_supplier, raw_quantity, film_id, quantity, match_status, quantity_status, suggestions, issue)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [documentId, lineNo, row.name, row.supplier ?? null, row.quantity === null ? null : String(row.quantity),
            match.filmId, parsed.quantity, match.matchStatus, parsed.quantityStatus,
            JSON.stringify(match.suggestions), issue],
        );
      }
      const previous = await tx.query<{ document_id: string }>(
        `SELECT document_id FROM stock_documents WHERE file_sha256 = $1 AND status = 'posted' AND document_id <> $2 ORDER BY document_id DESC LIMIT 1`,
        [input.fileSha256, documentId],
      );
      await recordDocumentAudit(tx, {
        event: 'inventory.document_created', ctx, documentId, docType: input.docType, warehouseId: input.warehouseId,
        orderId: null, statusCode: 'draft',
        after: { docType: input.docType, docDate: input.docDate, linesCount: input.rows.length },
        metadata: {
          docSource: 'import', fileName: input.fileName, fileSha256: input.fileSha256, sheetName: input.sheetName,
          linesCount: input.rows.length, matchStats: stats,
          previousPostedDocumentId: previous.rows[0] ? num(previous.rows[0].document_id) : null,
        },
      });
      const dto = await readDocument(tx, ctx.currentUser, documentId);
      await completeIdempotent(tx, ctx.idempotencyKey, String(documentId), dto);
      return dto;
    });
  }

  async updateLine(ctx: CommandContext, input: UpdateLineInput): Promise<StockDocumentDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.document.line_update', actorId: ctx.currentUser.id,
        entityType: 'stock_document', entityId: String(input.documentId), hash: requestHash(input),
      });
      if (replay !== undefined) return assertReplayVisible(tx, ctx.currentUser, replay);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      const doc = await this.lockDraft(tx, ctx.currentUser, input.documentId, input.version);
      const lines = await tx.query<LineRow>(
        `SELECT l.*, NULL::text AS film_name FROM stock_document_lines l WHERE l.document_id = $1 AND l.line_id = $2`,
        [input.documentId, input.lineId],
      );
      const line = lines.rows[0];
      if (!line) throw new ApiError(404, 'STOCK_DOCUMENT_LINE_NOT_FOUND', 'Строка документа не найдена');
      const before = { filmId: numOrNull(line.film_id), quantity: line.quantity === null ? null : Number(line.quantity), matchStatus: line.match_status, quantityStatus: line.quantity_status };
      const after = { ...before };
      const actions: string[] = [];
      if (input.skip === true) {
        after.matchStatus = 'skipped';
        actions.push('skipped');
      } else {
        if (input.filmId !== undefined) {
          await lockCanonicalFilms(tx, [input.filmId]);
          after.filmId = input.filmId;
          after.matchStatus = 'manual';
          actions.push('film_selected');
        } else if (input.confirmMatch === true) {
          if (before.matchStatus === 'suggested') {
            const top = Array.isArray(line.suggestions) ? (line.suggestions as Array<{ filmId: number }>)[0] : undefined;
            if (!top) throw new ApiError(422, 'STOCK_LINE_NO_SUGGESTION', 'Нет предложенной плёнки для подтверждения');
            await lockCanonicalFilms(tx, [top.filmId]);
            after.filmId = top.filmId;
          } else if (before.matchStatus === 'skipped' && before.filmId !== null) {
            await lockCanonicalFilms(tx, [before.filmId]);
          } else if (before.filmId === null) {
            throw new ApiError(422, 'STOCK_LINE_NO_FILM', 'Выберите плёнку');
          }
          after.matchStatus = 'confirmed';
          actions.push('match_confirmed');
        }
        if (input.quantity !== undefined) {
          after.quantity = Math.round(input.quantity * 100) / 100;
          after.quantityStatus = 'confirmed';
          actions.push('quantity_changed');
        } else if (input.confirmQuantity === true) {
          if (before.quantity === null) throw new ApiError(422, 'STOCK_LINE_NO_QUANTITY', 'Укажите количество');
          after.quantityStatus = 'confirmed';
          actions.push('quantity_confirmed');
        }
      }
      if (actions.length === 0) throw new ApiError(400, 'VALIDATION_FAILED', 'Нет изменений строки');
      await tx.query(
        `UPDATE stock_document_lines SET film_id = $3, quantity = $4, match_status = $5, quantity_status = $6
          WHERE document_id = $1 AND line_id = $2`,
        [input.documentId, input.lineId, after.filmId, after.quantity, after.matchStatus, after.quantityStatus],
      );
      await tx.query('UPDATE stock_documents SET version = version + 1 WHERE document_id = $1', [input.documentId]);
      await recordDocumentAudit(tx, {
        event: 'inventory.document_line_updated', ctx, documentId: input.documentId, docType: doc.docType,
        warehouseId: doc.warehouseId, orderId: doc.orderId, statusCode: after.matchStatus, lineId: input.lineId,
        before, after, metadata: { version: input.version + 1, lineAction: actions, quantityStatus: after.quantityStatus },
        filmIds: [before.filmId, after.filmId].filter((id): id is number => id !== null),
      });
      const dto = await readDocument(tx, ctx.currentUser, input.documentId);
      await completeIdempotent(tx, ctx.idempotencyKey, String(input.documentId), dto);
      return dto;
    });
  }

  async post(ctx: CommandContext, documentId: number, version: number, allowNegative: boolean): Promise<StockDocumentDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.document.post', actorId: ctx.currentUser.id,
        entityType: 'stock_document', entityId: String(documentId), hash: requestHash({ documentId, version, allowNegative }),
      });
      if (replay !== undefined) return assertReplayVisible(tx, ctx.currentUser, replay);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await this.lockDraft(tx, ctx.currentUser, documentId, version);
      await this.postLocked(tx, ctx, documentId, allowNegative);
      const dto = await readDocument(tx, ctx.currentUser, documentId);
      await completeIdempotent(tx, ctx.idempotencyKey, String(documentId), dto);
      return dto;
    });
  }

  async cancel(ctx: CommandContext, documentId: number, version: number): Promise<StockDocumentDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.document.cancel', actorId: ctx.currentUser.id,
        entityType: 'stock_document', entityId: String(documentId), hash: requestHash({ documentId, version }),
      });
      if (replay !== undefined) return assertReplayVisible(tx, ctx.currentUser, replay);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      const doc = await this.lockDraft(tx, ctx.currentUser, documentId, version);
      await tx.query(
        `UPDATE stock_documents SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), version = version + 1
          WHERE document_id = $1`,
        [documentId, ctx.currentUser.id],
      );
      await recordDocumentAudit(tx, {
        event: 'inventory.document_cancelled', ctx, documentId, docType: doc.docType, warehouseId: doc.warehouseId,
        orderId: doc.orderId, statusCode: 'cancelled', before: { status: 'draft' }, after: { status: 'cancelled' },
        metadata: { version: version + 1 },
      });
      const dto = await readDocument(tx, ctx.currentUser, documentId);
      await completeIdempotent(tx, ctx.idempotencyKey, String(documentId), dto);
      return dto;
    });
  }

  async orderFilmStock(user: CurrentUser, orderId: number): Promise<{ items: OrderFilmStockItemDto[] }> {
    if (!canViewOrders(user)) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    const { whereSql, params } = buildScopedOrderWhere(user, orderId);
    const orders = await this.database.query<ResourceDemandOrderRow>(`${ORDER_SELECT_SQL} WHERE ${whereSql}`, params);
    if (orders.rows.length === 0) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    const [projected] = await loadProjectedOrders(this.database, orders.rows, undefined);
    const films = await this.database.query<{ film_id: string; canonical_id: string; canonical_name: string; vendor_name: string | null }>(
      `SELECT DISTINCT od.film_id, c.film_id AS canonical_id, c.film_name AS canonical_name, v.vendor_name
         FROM order_details od
         JOIN films f ON f.film_id = od.film_id
         JOIN films c ON c.film_id = COALESCE(f.canonical_film_id, f.film_id)
         LEFT JOIN vendors v ON v.vendor_id = c.vendor_id
        WHERE od.order_id = $1 AND od.delete_flag = false AND od.film_id IS NOT NULL
        ORDER BY od.film_id`,
      [orderId],
    );
    const canonicalIds = [...new Set(films.rows.map((row) => num(row.canonical_id)))];
    const balances = canonicalIds.length === 0 ? [] : (await this.database.query<{ film_id: string; quantity: string }>(
      'SELECT film_id, sum(quantity) AS quantity FROM stock_balances WHERE film_id = ANY($1::bigint[]) GROUP BY film_id',
      [canonicalIds],
    )).rows;
    const stockByCanonical = new Map(balances.map((row) => [num(row.film_id), Number(row.quantity)]));
    // Потребность канона = сумма потребностей исходных film_id заказа, разрешённых в него.
    const canonicalOf = new Map(films.rows.map((row) => [num(row.film_id), num(row.canonical_id)]));
    const demand = new Map<number, number | null>();
    for (const line of projected?.lines ?? []) {
      if (line.kind !== 'film') continue;
      const canonical = canonicalOf.get(line.refId) ?? line.refId;
      const current = demand.has(canonical) ? demand.get(canonical)! : 0;
      demand.set(canonical, current === null || line.quantity === null ? null : current + line.quantity);
    }
    return {
      items: films.rows.map((row) => {
        const canonical = num(row.canonical_id);
        const stockLm = stockByCanonical.has(canonical) ? stockByCanonical.get(canonical)! : null;
        const demandLm = demand.has(canonical) ? demand.get(canonical)! : null;
        const status: OrderFilmStockItemDto['status'] = stockLm === null || stockLm <= 0 ? 'none'
          : demandLm === null ? 'unknown_demand'
            : stockLm >= demandLm ? 'enough' : 'short';
        return {
          filmId: num(row.film_id), canonicalFilmId: canonical, canonicalName: row.canonical_name,
          vendorName: row.vendor_name, stockLm, demandLm: demandLm === null ? null : Math.round(demandLm * 100) / 100, status,
        };
      }),
    };
  }

  // ------------------------------------------------------------ внутреннее

  private async assertWarehouse(tx: TransactionClient, warehouseId: number): Promise<void> {
    // FOR KEY SHARE: конфликтует с FOR UPDATE отключения склада; после ожидания
    // строка перечитывается, и отключённый склад отклоняется.
    const rows = await tx.query('SELECT 1 FROM warehouses WHERE warehouse_id = $1 AND is_active = true FOR KEY SHARE', [warehouseId]);
    if (rows.rows.length === 0) throw new ApiError(422, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
  }

  private async insertDocument(
    tx: TransactionClient,
    ctx: CommandContext,
    doc: { docType: StockDocType; warehouseId: number; docDate: string; source: 'manual' | 'import'; orderId: number | null; comment: string | null; fileName: string | null; fileSha256: string | null; sheetName: string | null; countedAt?: string | null },
  ): Promise<number> {
    const result = await tx.query<{ document_id: string }>(
      `INSERT INTO stock_documents
         (doc_type, status, warehouse_id, doc_date, source, order_id, file_name, file_sha256, sheet_name, comment,
          created_by, request_id, correlation_id, counted_at)
       VALUES ($1, 'draft', $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12::timestamptz)
       RETURNING document_id`,
      [doc.docType, doc.warehouseId, doc.docDate, doc.source, doc.orderId, doc.fileName, doc.fileSha256, doc.sheetName,
        doc.comment, ctx.currentUser.id, ctx.requestId, doc.docType === 'inventory' ? doc.countedAt ?? null : null],
    );
    return num(result.rows[0].document_id);
  }

  /** Блокировка документа, видимость по заказу, статус и версия (§7.2 п.1). */
  private async lockDraft(
    tx: TransactionClient,
    user: CurrentUser,
    documentId: number,
    version: number,
  ): Promise<{ docType: StockDocType; warehouseId: number; orderId: number | null }> {
    const rows = await tx.query<{ doc_type: StockDocType; warehouse_id: number; order_id: string | null; status: StockDocStatus; version: number }>(
      'SELECT doc_type, warehouse_id, order_id, status, version FROM stock_documents WHERE document_id = $1 FOR UPDATE',
      [documentId],
    );
    const doc = rows.rows[0];
    if (!doc) throw notFound();
    const orderId = numOrNull(doc.order_id);
    if (orderId !== null) {
      try {
        await assertOrderVisible(tx, user, orderId);
      } catch {
        throw notFound();
      }
    }
    if (doc.status !== 'draft') throw new ApiError(409, 'STOCK_DOCUMENT_NOT_DRAFT', 'Документ уже проведён или отменён');
    if (num(doc.version) !== version) throw new ApiError(409, 'STOCK_DOCUMENT_STALE', 'Документ изменён, обновите страницу', { currentVersion: num(doc.version) });
    return { docType: doc.doc_type, warehouseId: num(doc.warehouse_id), orderId };
  }

  /** Проведение под уже взятой блокировкой документа (§7.2 п.4). */
  private async postLocked(tx: TransactionClient, ctx: CommandContext, documentId: number, allowNegative: boolean): Promise<void> {
    const docRows = await tx.query<{ doc_type: StockDocType; warehouse_id: number; order_id: string | null; version: number }>(
      'SELECT doc_type, warehouse_id, order_id, version FROM stock_documents WHERE document_id = $1',
      [documentId],
    );
    const doc = docRows.rows[0];
    const lines = await tx.query<LineRow>(
      `SELECT l.*, NULL::text AS film_name FROM stock_document_lines l WHERE l.document_id = $1 ORDER BY l.line_no`,
      [documentId],
    );
    const states = lines.rows.map(lineState);
    const unresolved = findUnresolvedLines(states);
    if (unresolved.length > 0) {
      throw new ApiError(422, 'STOCK_DOCUMENT_UNRESOLVED', 'Не все строки сопоставлены и подтверждены', { unresolved });
    }
    const aggregated = aggregateLines(states);
    if (aggregated.size === 0) throw new ApiError(422, 'STOCK_DOCUMENT_EMPTY', 'В документе нет строк для проведения');
    const filmIds = [...aggregated.keys()];
    const names = await lockCanonicalFilms(tx, filmIds);
    const warehouseId = num(doc.warehouse_id);
    // Вставка отсутствующих строк остатков и блокировка — по возрастанию film_id (§3.3).
    await tx.query(
      `INSERT INTO stock_balances (warehouse_id, film_id, quantity)
       SELECT $1, id, 0 FROM unnest($2::bigint[]) AS id ORDER BY id
       ON CONFLICT (warehouse_id, film_id) DO NOTHING`,
      [warehouseId, filmIds],
    );
    const balanceRows = await tx.query<{ film_id: string; quantity: string }>(
      `SELECT film_id, quantity FROM stock_balances
        WHERE warehouse_id = $1 AND film_id = ANY($2::bigint[]) ORDER BY film_id FOR UPDATE`,
      [warehouseId, filmIds],
    );
    const balances = new Map(balanceRows.rows.map((row) => [num(row.film_id), toCents(Number(row.quantity))]));
    const planned = planMovements(doc.doc_type, aggregated, balances);
    const negative = negativeAfter(planned);
    if (negative.length > 0 && !allowNegative) {
      throw new ApiError(409, 'STOCK_WOULD_GO_NEGATIVE', 'Остаток уйдёт в минус — подтвердите проведение', {
        negativeAfter: negative.map((item) => ({ ...item, filmName: names.get(item.filmId) ?? '' })),
      });
    }
    const orderId = numOrNull(doc.order_id);
    for (const movement of planned) {
      await tx.query(
        `INSERT INTO stock_movements
           (document_id, warehouse_id, film_id, movement_type, delta, balance_before, balance_after, order_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [documentId, warehouseId, movement.filmId, movement.movementType, fromCents(movement.deltaCents),
          fromCents(movement.beforeCents), fromCents(movement.afterCents), orderId, ctx.currentUser.id],
      );
      await tx.query(
        'UPDATE stock_balances SET quantity = $3, last_movement_at = now() WHERE warehouse_id = $1 AND film_id = $2',
        [warehouseId, movement.filmId, fromCents(movement.afterCents)],
      );
    }
    let onecGenerations = 0;
    let onecAppliedReset = 0;
    if (doc.doc_type === 'inventory') {
      // Инвентаризация ставит абсолютный остаток: расход 1С по этим плёнкам поглощён (план 1С-расхода §4.3а).
      // Под уже взятой блокировкой stock_balances (w, f): отсечка = момент подсчёта, поколение +1 на КАЖДОЕ
      // проведение, применённый расход 1С по (w, f) := 0 без движений. Блокировку проекции не берём.
      const counted = await tx.query<{ counted_at: Date }>(
        `UPDATE stock_documents SET counted_at = COALESCE(counted_at, now()) WHERE document_id = $1 RETURNING counted_at`,
        [documentId],
      );
      const countedAt = counted.rows[0].counted_at;
      if (countedAt.getTime() > Date.now() + 60_000) {
        throw new ApiError(422, 'STOCK_COUNTED_AT_IN_FUTURE', 'Момент подсчёта инвентаризации позже проведения');
      }
      for (const filmId of [...filmIds].sort((a, b) => a - b)) {
        await tx.query(
          `INSERT INTO inventory_onec_generation (warehouse_id, film_id, gen, counted_at, inventory_document_id)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (warehouse_id, film_id) DO UPDATE
             SET gen = inventory_onec_generation.gen + 1, counted_at = EXCLUDED.counted_at,
                 inventory_document_id = EXCLUDED.inventory_document_id, updated_at = now()`,
          [warehouseId, filmId, countedAt, documentId],
        );
      }
      const reset = await tx.query(
        `UPDATE inventory_onec_applied SET quantity = 0, updated_at = now()
          WHERE warehouse_id = $1 AND film_id = ANY($2::bigint[]) AND quantity <> 0`,
        [warehouseId, filmIds],
      );
      onecGenerations = filmIds.length;
      onecAppliedReset = reset.rowCount ?? 0;
    }
    // Алиасы: сбор, схлопывание повторов внутри документа и upsert в едином порядке ключей —
    // два проведения с общими алиасами берут их блокировки в одинаковом порядке (без deadlock).
    const aliasByKey = new Map<string, { nameNorm: string; supplierNorm: string; filmId: number }>();
    for (const line of lines.rows) {
      if ((line.match_status === 'confirmed' || line.match_status === 'manual') && line.raw_name && line.film_id !== null) {
        const parsed = parseNameWithQuantity(line.raw_name);
        const name = line.raw_quantity !== null && String(line.raw_quantity).trim() !== '' ? line.raw_name : parsed.name;
        const [nameNorm, supplierNorm] = aliasKey(name, line.raw_supplier ?? '').split('|');
        if (!nameNorm) continue;
        aliasByKey.set(`${nameNorm}|${supplierNorm}`, { nameNorm, supplierNorm, filmId: num(line.film_id) });
      }
    }
    for (const key of [...aliasByKey.keys()].sort()) {
      const { nameNorm, supplierNorm, filmId } = aliasByKey.get(key)!;
      {
        await tx.query(
          `INSERT INTO stock_import_aliases (source_name_norm, source_supplier_norm, film_id, created_by, last_used_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (source_name_norm, source_supplier_norm)
           DO UPDATE SET film_id = EXCLUDED.film_id, last_used_at = now()`,
          [nameNorm, supplierNorm, filmId, ctx.currentUser.id],
        );
      }
    }
    await tx.query(
      `UPDATE stock_documents SET status = 'posted', posted_by = $2, posted_at = now(), version = version + 1
        WHERE document_id = $1`,
      [documentId, ctx.currentUser.id],
    );
    const sumDeltaCents = planned.reduce((acc, movement) => acc + movement.deltaCents, 0);
    await recordDocumentAudit(tx, {
      event: 'inventory.document_posted', ctx, documentId, docType: doc.doc_type, warehouseId, orderId,
      statusCode: 'posted', before: { status: 'draft' }, after: { status: 'posted' },
      metadata: { filmCount: planned.length, sumDelta: fromCents(sumDeltaCents), allowNegative, negativeCount: negative.length, onecGenerations, onecAppliedReset },
      filmIds,
    });
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('inventory.stock_changed', 'stock_document', $1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        String(documentId),
        JSON.stringify({
          eventId: randomUUID(), eventType: 'inventory.stock_changed', action: 'posted',
          actorUserId: ctx.currentUser.id, requestId: ctx.requestId, correlationId: ctx.requestId, source: SOURCE,
          occurredAt: new Date().toISOString(), entity: { type: 'stock_document', id: documentId },
          warehouseId, docType: doc.doc_type, orderId,
          lines: planned.map((movement) => ({ filmId: movement.filmId, delta: fromCents(movement.deltaCents), balanceAfter: fromCents(movement.afterCents) })),
        }),
        `inventory:document:${documentId}:posted`,
      ],
    );
  }
}
