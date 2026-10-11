import { randomUUID } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { OnecWarehouse } from '../../onec-agent/onec-catalog-reader';
import type { ConsumptionDocumentView } from '../application/onec-consumption.port';
import { parseStockKey, stockKey, type ProjectionContext, type ProjectionIssue, type ProjectionWarehouse } from '../domain/onec-projection';
import { onecBaselineGaps } from './pg-warehouse-repository';

// Чтение и запись проекции расхода 1С (план 2026-09-30-onec-consumption-documents-plan.md §4.2–4.5).
// Порядок блокировок транзакции документа: onec_documents FOR SHARE (порт 1С) → inventory_onec_projection
// FOR UPDATE → warehouses FOR KEY SHARE → films FOR SHARE → stock_balances FOR UPDATE → запись.

export const PROJECTION_SOURCE = 'onec_consumption';

const fromCents = (cents: number): string => (cents / 100).toFixed(2);
const toCents = (value: string | number): number => Math.round(Number(value) * 100);

/** Автор дельты: служебный пользователь прохода или пользователь, запустивший компенсацию (§4.8). */
export interface ProjectionActor { id: number; username: string; role?: string }

export const COMPENSATE_SOURCE = 'onec_consumption_compensate';

const DOC_KIND_LABEL: Record<string, string> = {
  sales_shipment: 'Реализация', supplier_return: 'Возврат поставщику', inventory_writeoff: 'Списание', inventory_transfer: 'Перемещение',
  purchase_receipt: 'Поступление',
};

/** Комментарий документа-дельты: что из 1С его породило (журнал склада). */
export function onecDeltaComment(view: ConsumptionDocumentView | null, reason: 'projection' | 'compensate'): string {
  if (reason === 'compensate') return '1С: откат учёта склада (компенсация)';
  if (view === null) return '1С: документ больше не участвует в учёте склада';
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(view.docDate);
  return `1С: ${DOC_KIND_LABEL[view.docKind] ?? view.docKind} № ${view.number} от ${date ? `${date[3]}.${date[2]}.${date[1]}` : view.docDate}`;
}

export interface OnecIssueDto {
  issueId: number; onecDocumentId: number; onecLineId: number | null; code: string; warehouseId: number | null;
  nomenclatureRefKey: string | null; quantity: number | null; docKind: string | null; docNumber: string | null;
  docDate: string | null; docAt: string | null; filmId: number | null; filmName: string | null; updatedAt: string;
}

export interface StoredProjectionState { onecDocumentId: number; onecSourceId: number; inputsHash: string | null; gone: boolean }

export class PgOnecProjectionRepository {
  /**
   * Контекст проекции: склады ERP с ключом 1С (активность, момент начала, авторитетный источник по складам
   * зеркала, ворота), привязки позиций 1С к каноническим плёнкам, поколения инвентаризаций. Без блокировок
   * (отбор кандидатов) или после блокировок транзакции документа.
   */
  async context(client: DatabaseClient, onecWarehouses: readonly OnecWarehouse[], itemRefKeys: readonly string[]): Promise<ProjectionContext> {
    const sourcesByKey = new Map<string, Set<number>>();
    for (const row of onecWarehouses) {
      const key = row.refKey.toLowerCase();
      if (!sourcesByKey.has(key)) sourcesByKey.set(key, new Set());
      sourcesByKey.get(key)!.add(row.sourceId);
    }
    const warehouses = await client.query<{ warehouse_id: number; ref_key_1c: string; is_active: boolean; onec_consumption_since: Date | null }>(
      `SELECT warehouse_id, ref_key_1c::text AS ref_key_1c, is_active, onec_consumption_since
         FROM warehouses WHERE ref_key_1c IS NOT NULL ORDER BY warehouse_id`,
    );
    const warehouseByRefKey = new Map<string, ProjectionWarehouse>();
    const warehouseById = new Map<number, ProjectionWarehouse>();
    for (const row of warehouses.rows) {
      const refKey = row.ref_key_1c.toLowerCase();
      const sources = sourcesByKey.get(refKey);
      const since = row.onec_consumption_since === null ? null : new Date(row.onec_consumption_since).toISOString();
      const warehouseId = Number(row.warehouse_id);
      const baselineOk = since === null ? true : (await onecBaselineGaps(client, warehouseId)).length === 0;
      const value: ProjectionWarehouse = {
        warehouseId, active: row.is_active === true, since, baselineOk,
        source: !sources || sources.size === 0 ? null : sources.size > 1 ? 'ambiguous' : [...sources][0],
      };
      warehouseByRefKey.set(refKey, value);
      warehouseById.set(warehouseId, value);
    }
    const keys = [...new Set(itemRefKeys.map((key) => key.toLowerCase()))].filter((key) => /^[0-9a-f-]{36}$/.test(key));
    const films = keys.length === 0 ? { rows: [] as Array<{ key: string; canonical: string }> } : await client.query<{ key: string; canonical: string }>(
      `SELECT lower(ref_key_1c::text) AS key, COALESCE(canonical_film_id, film_id) AS canonical
         FROM films WHERE ref_key_1c = ANY($1::uuid[])`,
      [keys],
    );
    const generations = await client.query<{ warehouse_id: number; film_id: string; gen: string; counted_at: Date }>(
      'SELECT warehouse_id, film_id, gen, counted_at FROM inventory_onec_generation',
    );
    return {
      warehouseByRefKey,
      warehouseById,
      filmByRefKey: new Map(films.rows.map((row) => [row.key, Number(row.canonical)])),
      generation: new Map(generations.rows.map((row) => [
        stockKey(Number(row.warehouse_id), Number(row.film_id)),
        { gen: Number(row.gen), countedAt: new Date(row.counted_at).toISOString() },
      ])),
    };
  }

  async states(client: DatabaseClient): Promise<Map<number, StoredProjectionState>> {
    const { rows } = await client.query<{ onec_document_id: string; onec_source_id: string; inputs_hash: string | null; gone: boolean }>(
      'SELECT onec_document_id, onec_source_id, inputs_hash, gone FROM inventory_onec_projection',
    );
    return new Map(rows.map((row) => [Number(row.onec_document_id), {
      onecDocumentId: Number(row.onec_document_id), onecSourceId: Number(row.onec_source_id), inputsHash: row.inputs_hash, gone: row.gone,
    }]));
  }

  /** Склады применённого по документам (для заморозки при отборе кандидатов). */
  async appliedWarehouses(client: DatabaseClient, documentIds?: readonly number[]): Promise<Map<number, number[]>> {
    const { rows } = await client.query<{ onec_document_id: string; warehouses: number[] }>(
      `SELECT onec_document_id, array_agg(DISTINCT warehouse_id) AS warehouses FROM inventory_onec_applied
        WHERE ($1::bigint[] IS NULL OR onec_document_id = ANY($1::bigint[])) AND quantity <> 0 GROUP BY onec_document_id`,
      [documentIds ? [...documentIds] : null],
    );
    return new Map(rows.map((row) => [Number(row.onec_document_id), row.warehouses.map(Number)]));
  }

  /** Документы 1С с применённым расходом на складе (компенсация). */
  async documentsWithApplied(client: DatabaseClient, warehouseId: number): Promise<number[]> {
    const { rows } = await client.query<{ onec_document_id: string }>(
      'SELECT DISTINCT onec_document_id FROM inventory_onec_applied WHERE warehouse_id = $1 AND quantity <> 0 ORDER BY onec_document_id',
      [warehouseId],
    );
    return rows.map((row) => Number(row.onec_document_id));
  }

  async appliedTotal(client: DatabaseClient, warehouseId: number): Promise<number> {
    const { rows } = await client.query<{ total: string }>(
      'SELECT COALESCE(sum(abs(quantity)), 0) AS total FROM inventory_onec_applied WHERE warehouse_id = $1',
      [warehouseId],
    );
    return Number(rows[0].total);
  }

  /** «Не учтено из 1С» по складу: причина, позиция 1С (и плёнка, если привязана), документ; BEFORE_CUTOFF — по запросу. */
  async listIssues(
    client: DatabaseClient,
    filter: { warehouseId: number | null; code: string | null; includeBeforeCutoff: boolean; offset: number; limit: number },
  ): Promise<{ total: number; items: OnecIssueDto[]; counts: Array<{ code: string; count: number }> }> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.warehouseId !== null) where.push(`i.warehouse_id = $${params.push(filter.warehouseId)}`);
    if (filter.code !== null) where.push(`i.code = $${params.push(filter.code)}`);
    else if (!filter.includeBeforeCutoff) where.push(`i.code <> 'BEFORE_CUTOFF'`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitIndex = params.push(filter.limit);
    const offsetIndex = params.push(filter.offset);
    const { rows } = await client.query<{
      issue_id: string; onec_document_id: string; onec_line_id: string | null; code: string; warehouse_id: number | null;
      nomenclature_ref_key: string | null; quantity: string | null; details: Record<string, unknown> | null; updated_at: Date;
      film_id: string | null; film_name: string | null; total: string;
    }>(
      `SELECT i.issue_id, i.onec_document_id, i.onec_line_id, i.code, i.warehouse_id, i.nomenclature_ref_key::text AS nomenclature_ref_key,
              i.quantity, i.details, i.updated_at, f.film_id, f.film_name, count(*) OVER () AS total
         FROM inventory_onec_issues i
         LEFT JOIN films f ON f.ref_key_1c = i.nomenclature_ref_key
         ${whereSql}
        ORDER BY i.updated_at DESC, i.issue_id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    const countParams: unknown[] = [];
    const countWhere = filter.warehouseId !== null ? `WHERE warehouse_id = $${countParams.push(filter.warehouseId)}` : '';
    const counts = await client.query<{ code: string; count: string }>(
      `SELECT code, count(*) AS count FROM inventory_onec_issues ${countWhere} GROUP BY code ORDER BY code`,
      countParams,
    );
    return {
      total: rows.length ? Number(rows[0].total) : 0,
      counts: counts.rows.map((row) => ({ code: row.code, count: Number(row.count) })),
      items: rows.map((row) => ({
        issueId: Number(row.issue_id), onecDocumentId: Number(row.onec_document_id),
        onecLineId: row.onec_line_id === null ? null : Number(row.onec_line_id), code: row.code,
        warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id), nomenclatureRefKey: row.nomenclature_ref_key,
        quantity: row.quantity === null ? null : Number(row.quantity),
        docKind: (row.details?.docKind as string | undefined) ?? null, docNumber: (row.details?.number as string | undefined) ?? null,
        docDate: (row.details?.docDate as string | undefined) ?? null, docAt: (row.details?.docAt as string | undefined) ?? null,
        filmId: row.film_id === null ? null : Number(row.film_id), filmName: row.film_name,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    };
  }

  /** Точка сериализации прохода по документу. null — состояния нет и документа нет (нечего проецировать). */
  async lockState(tx: TransactionClient, onecDocumentId: number, view: ConsumptionDocumentView | null): Promise<StoredProjectionState | null> {
    if (view) {
      await tx.query(
        `INSERT INTO inventory_onec_projection (onec_document_id, onec_source_id, onec_ref_key)
         VALUES ($1, $2, $3::uuid) ON CONFLICT (onec_document_id) DO NOTHING`,
        [onecDocumentId, view.sourceId, view.onecRefKey],
      );
    }
    const { rows } = await tx.query<{ onec_source_id: string; inputs_hash: string | null; gone: boolean }>(
      'SELECT onec_source_id, inputs_hash, gone FROM inventory_onec_projection WHERE onec_document_id = $1 FOR UPDATE',
      [onecDocumentId],
    );
    return rows[0] ? { onecDocumentId, onecSourceId: Number(rows[0].onec_source_id), inputsHash: rows[0].inputs_hash, gone: rows[0].gone } : null;
  }

  async applied(tx: DatabaseClient, onecDocumentId: number): Promise<Map<string, number>> {
    const { rows } = await tx.query<{ warehouse_id: number; film_id: string; quantity: string }>(
      'SELECT warehouse_id, film_id, quantity FROM inventory_onec_applied WHERE onec_document_id = $1',
      [onecDocumentId],
    );
    return new Map(rows.map((row) => [stockKey(Number(row.warehouse_id), Number(row.film_id)), toCents(row.quantity)]));
  }

  async lockWarehouses(tx: TransactionClient, warehouseIds: readonly number[]): Promise<void> {
    if (warehouseIds.length === 0) return;
    await tx.query('SELECT warehouse_id FROM warehouses WHERE warehouse_id = ANY($1::smallint[]) ORDER BY warehouse_id FOR KEY SHARE', [[...warehouseIds]]);
  }

  /** Плёнки по ключам 1С FOR SHARE по возрастанию: связанная плёнка и её канон (слияние ждёт commit). */
  async lockFilms(tx: TransactionClient, itemRefKeys: readonly string[]): Promise<void> {
    const keys = [...new Set(itemRefKeys.map((key) => key.toLowerCase()))].filter((key) => /^[0-9a-f-]{36}$/.test(key));
    if (keys.length === 0) return;
    await tx.query(
      `SELECT film_id FROM films
        WHERE film_id IN (SELECT film_id FROM films WHERE ref_key_1c = ANY($1::uuid[])
                          UNION SELECT canonical_film_id FROM films WHERE ref_key_1c = ANY($1::uuid[]) AND canonical_film_id IS NOT NULL)
        ORDER BY film_id FOR SHARE`,
      [keys],
    );
  }

  /** Остатки (w, f): недостающие строки создаются, затем FOR UPDATE по (warehouse_id, film_id). */
  async lockBalances(tx: TransactionClient, keys: readonly string[]): Promise<Map<string, number>> {
    const pairs = [...new Set(keys)].map(parseStockKey).sort((a, b) => a.warehouseId - b.warehouseId || a.filmId - b.filmId);
    if (pairs.length === 0) return new Map();
    const warehouses = pairs.map((pair) => pair.warehouseId);
    const films = pairs.map((pair) => pair.filmId);
    await tx.query(
      `INSERT INTO stock_balances (warehouse_id, film_id, quantity)
       SELECT w, f, 0 FROM unnest($1::smallint[], $2::bigint[]) AS t(w, f) ORDER BY w, f
       ON CONFLICT (warehouse_id, film_id) DO NOTHING`,
      [warehouses, films],
    );
    const { rows } = await tx.query<{ warehouse_id: number; film_id: string; quantity: string }>(
      `SELECT b.warehouse_id, b.film_id, b.quantity FROM stock_balances b
         JOIN unnest($1::smallint[], $2::bigint[]) AS t(w, f) ON b.warehouse_id = t.w AND b.film_id = t.f
        ORDER BY b.warehouse_id, b.film_id FOR UPDATE OF b`,
      [warehouses, films],
    );
    return new Map(rows.map((row) => [stockKey(Number(row.warehouse_id), Number(row.film_id)), toCents(row.quantity)]));
  }

  /**
   * Документ-дельта по складу: новый проведённый документ source/doc_type = 'onec' с движениями `onec`
   * (минус разрешён — факт 1С), обновление остатков, аудит и событие outbox (ключ — id документа).
   */
  async writeDelta(
    tx: TransactionClient,
    input: {
      actor: ProjectionActor; requestId: string; view: ConsumptionDocumentView | null; onecDocumentId: number;
      onecSourceId: number; onecRefKey: string; warehouseId: number; deltas: Map<number, number>; balances: Map<string, number>;
      reason?: 'projection' | 'compensate';
    },
  ): Promise<number> {
    const reason = input.reason ?? 'projection';
    const source = reason === 'compensate' ? COMPENSATE_SOURCE : PROJECTION_SOURCE;
    const seq = await tx.query<{ next: string }>(
      `SELECT COALESCE(max(projection_seq), 0) + 1 AS next FROM stock_documents
        WHERE source = 'onec' AND onec_document_id = $1 AND warehouse_id = $2`,
      [input.onecDocumentId, input.warehouseId],
    );
    const projectionSeq = Number(seq.rows[0].next);
    const docDate = input.view?.docDate ?? new Date().toISOString().slice(0, 10);
    const doc = await tx.query<{ document_id: string }>(
      `INSERT INTO stock_documents
         (doc_type, status, warehouse_id, doc_date, source, created_by, posted_by, posted_at, request_id, correlation_id,
          onec_document_id, onec_source_id, onec_ref_key, onec_revision, projection_seq, comment)
       VALUES ('onec', 'posted', $1, $2::date, 'onec', $3, $3, now(), $4, $4, $5, $6, $7::uuid, $8, $9, $10)
       RETURNING document_id`,
      [input.warehouseId, docDate, input.actor.id, input.requestId, input.onecDocumentId, input.onecSourceId, input.onecRefKey,
        input.view?.revision ?? null, projectionSeq,
        onecDeltaComment(input.view, reason)],
    );
    const documentId = Number(doc.rows[0].document_id);
    const lines: Array<{ filmId: number; delta: string; before: string; after: string }> = [];
    for (const filmId of [...input.deltas.keys()].sort((a, b) => a - b)) {
      const deltaCents = input.deltas.get(filmId)!;
      const key = stockKey(input.warehouseId, filmId);
      const beforeCents = input.balances.get(key) ?? 0;
      const afterCents = beforeCents + deltaCents;
      input.balances.set(key, afterCents);
      await tx.query(
        `INSERT INTO stock_movements (document_id, warehouse_id, film_id, movement_type, delta, balance_before, balance_after, created_by)
         VALUES ($1, $2, $3, 'onec', $4, $5, $6, $7)`,
        [documentId, input.warehouseId, filmId, fromCents(deltaCents), fromCents(beforeCents), fromCents(afterCents), input.actor.id],
      );
      await tx.query(
        'UPDATE stock_balances SET quantity = $3, last_movement_at = now() WHERE warehouse_id = $1 AND film_id = $2',
        [input.warehouseId, filmId, fromCents(afterCents)],
      );
      lines.push({ filmId, delta: fromCents(deltaCents), before: fromCents(beforeCents), after: fromCents(afterCents) });
    }
    await auditService.record(tx, {
      event: 'inventory.onec_consumption_applied',
      entityType: 'stock_document',
      entityId: documentId,
      actorUserId: input.actor.id,
      actorUsername: input.actor.username,
      actorRole: input.actor.role ?? 'integration_service',
      requestId: input.requestId,
      source,
      statusField: 'status',
      statusCode: 'posted',
      stageCode: 'onec',
      before: { balances: Object.fromEntries(lines.map((line) => [line.filmId, line.before])) },
      after: { balances: Object.fromEntries(lines.map((line) => [line.filmId, line.after])) },
      diff: Object.fromEntries(lines.map((line) => [line.filmId, { delta: line.delta }])),
      metadata: {
        documentId, warehouseId: input.warehouseId, onecDocumentId: input.onecDocumentId, onecSourceId: input.onecSourceId,
        onecRefKey: input.onecRefKey, onecRevision: input.view?.revision ?? null, onecDocKind: input.view?.docKind ?? null,
        projectionSeq, filmCount: lines.length, correlationId: input.requestId, commandSource: source, reason,
      },
      relatedEntities: [
        { entityType: 'stock_document', entityId: documentId },
        { entityType: 'warehouse', entityId: input.warehouseId },
        { entityType: 'onec_document', entityId: input.onecDocumentId },
        ...lines.map((line) => ({ entityType: 'film', entityId: line.filmId })),
      ],
    });
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('inventory.stock_changed', 'stock_document', $1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        String(documentId),
        JSON.stringify({
          eventId: randomUUID(), eventType: 'inventory.stock_changed', action: reason === 'compensate' ? 'onec_consumption_compensate' : 'onec_consumption',
          actorUserId: input.actor.id, requestId: input.requestId, correlationId: input.requestId, source,
          occurredAt: new Date().toISOString(), entity: { type: 'stock_document', id: documentId },
          warehouseId: input.warehouseId, docType: 'onec', onecDocumentId: input.onecDocumentId, projectionSeq,
          lines: lines.map((line) => ({ filmId: line.filmId, delta: line.delta, balanceAfter: line.after })),
        }),
        `inventory:document:${documentId}:posted`,
      ],
    );
    return documentId;
  }

  /** Применённое документа := nextApplied (нули удаляются), состояние и «не учтено» — целиком. */
  async saveOutcome(
    tx: TransactionClient,
    input: { onecDocumentId: number; nextApplied: Map<string, number>; view: ConsumptionDocumentView | null; hash: string; issues: ProjectionIssue[] },
  ): Promise<void> {
    await tx.query('DELETE FROM inventory_onec_applied WHERE onec_document_id = $1', [input.onecDocumentId]);
    const rows = [...input.nextApplied].filter(([, cents]) => cents !== 0).map(([key, cents]) => ({ ...parseStockKey(key), cents }));
    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO inventory_onec_applied (onec_document_id, warehouse_id, film_id, quantity)
         SELECT $1, w, f, q FROM unnest($2::smallint[], $3::bigint[], $4::numeric[]) AS t(w, f, q)`,
        [input.onecDocumentId, rows.map((row) => row.warehouseId), rows.map((row) => row.filmId), rows.map((row) => fromCents(row.cents))],
      );
    }
    await tx.query(
      `UPDATE inventory_onec_projection
          SET applied_revision = $2, inputs_hash = $3, gone = $4, projected_at = now(), updated_at = now()
        WHERE onec_document_id = $1`,
      [input.onecDocumentId, input.view?.revision ?? null, input.hash, input.view === null],
    );
    await tx.query('DELETE FROM inventory_onec_issues WHERE onec_document_id = $1', [input.onecDocumentId]);
    if (input.issues.length > 0) {
      await tx.query(
        `INSERT INTO inventory_onec_issues (onec_document_id, onec_line_id, code, warehouse_id, nomenclature_ref_key, quantity, details)
         SELECT $1, l, c, w, n::uuid, q::numeric, $7::jsonb FROM unnest($2::bigint[], $3::text[], $4::smallint[], $5::text[], $6::text[]) AS t(l, c, w, n, q)`,
        [input.onecDocumentId, input.issues.map((issue) => issue.lineId), input.issues.map((issue) => issue.code),
          input.issues.map((issue) => issue.warehouseId), input.issues.map((issue) => issue.nomenclatureRefKey),
          input.issues.map((issue) => issue.quantity),
          JSON.stringify(input.view ? { docKind: input.view.docKind, number: input.view.number, docDate: input.view.docDate, docAt: input.view.docAt } : null)],
      );
    }
  }
}
