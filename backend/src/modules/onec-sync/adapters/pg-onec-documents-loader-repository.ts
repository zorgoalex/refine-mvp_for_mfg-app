import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import type {
  AppliedDocumentLine,
  DocumentLineChange,
  DocumentLineState,
  LineConflictCode,
  LoadedDocumentView,
  OnecDocumentConsumers,
} from '../application/onec-document-consumers';
import {
  buildTarget,
  documentKindOf,
  entityDocKinds,
  NORMALIZER_VERSION,
  parseDocument,
  type DocumentEntityConfig,
  type OnecDocKind,
  type OnecUnitCode,
  type ReferenceData,
  type TargetHeader,
  type TargetLine,
} from '../domain/onec-document-normalizer';

// Загрузка одного документа 1С в onec_documents / onec_document_lines — одна транзакция на документ
// (план 2026-09-30-onec-documents-loader-plan.md: Р3, Р8, Р9, Р11, R1-1…R1-6, R2-1…R2-4, R3-1, R3-2).
// Порядок блокировок: onec_etl_entity_state FOR SHARE → шапка FOR NO KEY UPDATE → все строки документа по
// возрастанию id FOR NO KEY UPDATE (удаляемая — FOR UPDATE) → проверки потребителей (только чтение их данных) →
// реестры потребителей в конце. orders / order_resource_procurement не блокируются никогда.

export const CONFLICT_ALERT_KIND = 'onec_document_conflict';
const SOURCE = 'onec_loader';

export interface LoadContext {
  sourceId: number;
  entityCode: string;
  config: DocumentEntityConfig;
  /** Действующие виды (план §3.3): документ недействующего вида пропускается. */
  enabledKinds: ReadonlySet<OnecDocKind>;
  requestId: string;
  correlationId: string;
  runId: string | null;
}

/** Контекст одного документа: вид определяется по данным документа (`ВидОперации`). */
type DocContext = LoadContext & { docKind: OnecDocKind };

export type DocumentOutcome =
  | {
    status: 'created' | 'changed' | 'unchanged' | 'skipped' | 'upgraded';
    conflicts: number;
    /** Документ вида `docKind` после загрузки (кроме skipped). */
    documentId?: number;
    docKind?: OnecDocKind;
    /** Документы прежнего вида, удалённые при смене вида (§3.2). */
    removed?: Array<{ documentId: number; docKind: OnecDocKind }>;
  }
  | { status: 'invalid'; code: string };

interface HeaderRow extends QueryResultRow {
  onec_document_id: string;
  doc_kind: OnecDocKind;
  doc_at: string | null;
  operation_kind: string | null;
  warehouse_ref_key: string | null;
  destination_warehouse_ref_key: string | null;
  normalizer_version: string | null;
  number: string;
  doc_date: string;
  posted: boolean;
  deleted_in_onec: boolean;
  counterparty_ref_key: string | null;
  counterparty_name: string | null;
  supplier_id: string | null;
  amount: string | null;
  currency: string | null;
  comment: string | null;
  observed_fingerprint: string | null;
  applied_fingerprint: string | null;
  applied_revision: string;
  load_conflict: { proposedAmount?: string | null } | null;
  missing_in_source_at: Date | null;
  mapping_issue: string | null;
}

interface LineRow extends QueryResultRow {
  onec_document_line_id: string;
  line_no: number;
  nomenclature_ref_key: string | null;
  nomenclature_name: string | null;
  quantity: string;
  unit_name: string | null;
  unit_code: OnecUnitCode | null;
  price: string | null;
  amount: string | null;
  is_document_total: boolean;
  sheet_material_type_id: string | null;
  film_id: string | null;
  onec_order_ref_key: string | null;
  removed_in_onec_at: Date | null;
  load_conflict_code: LineConflictCode | null;
  mapping_issue: string | null;
  warehouse_ref_key: string | null;
  is_stock_item: boolean;
  unit_is_package: boolean;
}

const HEADER_SELECT = `SELECT onec_document_id::text, doc_kind,
  to_char(doc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS doc_at, operation_kind, warehouse_ref_key::text,
  destination_warehouse_ref_key::text, normalizer_version, number, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, posted, deleted_in_onec,
  counterparty_ref_key::text, counterparty_name, supplier_id::text, amount::text, currency, comment, observed_fingerprint,
  applied_fingerprint, applied_revision::text, load_conflict, missing_in_source_at, mapping_issue
  FROM onec_documents`;
const LINE_SELECT = `SELECT onec_document_line_id::text, line_no, nomenclature_ref_key::text, nomenclature_name, quantity::text,
  unit_name, unit_code, price::text, amount::text, is_document_total, sheet_material_type_id::text, film_id::text,
  onec_order_ref_key::text, removed_in_onec_at, load_conflict_code, mapping_issue, warehouse_ref_key::text, is_stock_item,
  unit_is_package
  FROM onec_document_lines`;

const num = (value: string | null): number | null => (value === null ? null : Number(value));
const sameNumber = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : Number(left) === Number(right);

function stateOfRow(row: LineRow): DocumentLineState {
  return {
    lineNo: row.line_no,
    quantity: row.quantity,
    amount: row.amount,
    unitCode: row.unit_code,
    sheetMaterialTypeId: num(row.sheet_material_type_id),
    filmId: num(row.film_id),
    isDocumentTotal: row.is_document_total,
  };
}

function stateOfTarget(line: TargetLine): DocumentLineState {
  return {
    lineNo: line.lineNo,
    quantity: line.quantity,
    amount: line.amount,
    unitCode: line.unitCode,
    sheetMaterialTypeId: line.sheetMaterialTypeId,
    filmId: line.filmId,
    isDocumentTotal: line.isDocumentTotal,
  };
}

/** Строка в БД совпадает с целевой: поля v1 и (withV2) поля, добавленные в v2 (склад, признаки строки). */
function lineMatches(row: LineRow, line: TargetLine, withV2 = true): boolean {
  if (withV2 && (row.warehouse_ref_key !== line.warehouseRefKey || row.is_stock_item !== line.isStockItem
    || row.unit_is_package !== line.unitIsPackage)) return false;
  return row.nomenclature_ref_key === line.nomenclatureRefKey
    && row.nomenclature_name === line.nomenclatureName
    && sameNumber(row.quantity, line.quantity)
    && row.unit_name === line.unitName
    && row.unit_code === line.unitCode
    && sameNumber(row.price, line.price)
    && sameNumber(row.amount, line.amount)
    && row.is_document_total === line.isDocumentTotal
    && num(row.sheet_material_type_id) === line.sheetMaterialTypeId
    && num(row.film_id) === line.filmId
    && row.onec_order_ref_key === line.onecOrderRefKey
    && row.mapping_issue === line.mappingIssue;
}

/** Строка для аудита (Р13): применённое состояние. */
function lineAudit(row: LineRow) {
  return {
    lineId: Number(row.onec_document_line_id), lineNo: row.line_no, nomenclatureRefKey: row.nomenclature_ref_key,
    nomenclatureName: row.nomenclature_name, quantity: row.quantity, unitCode: row.unit_code, price: row.price, amount: row.amount,
    sheetMaterialTypeId: num(row.sheet_material_type_id), filmId: num(row.film_id), onecOrderRefKey: row.onec_order_ref_key,
    removedInOnec: row.removed_in_onec_at !== null, conflictCode: row.load_conflict_code, mappingIssue: row.mapping_issue,
    warehouseRefKey: row.warehouse_ref_key, isStockItem: row.is_stock_item, unitIsPackage: row.unit_is_package,
  };
}

export class PgOnecDocumentsLoaderRepository {
  constructor(
    readonly database: DatabaseService,
    private readonly reader: OnecCatalogReader,
    private readonly consumers: OnecDocumentConsumers,
    private readonly alerts: OnecAlertsPort,
  ) {}

  /** Справочные значения источника — один раз на проход (Р4/R1-4: изменение даёт новый отпечаток). */
  async loadReferences(sourceId: number): Promise<ReferenceData> {
    const [units, items, counterparties] = await Promise.all([
      this.reader.entityData(sourceId, 'units'),
      this.reader.entityData(sourceId, 'items'),
      this.reader.entityData(sourceId, 'counterparties'),
    ]);
    const group = (rows: Array<{ key: string; id: string }>) => {
      const map = new Map<string, number[]>();
      for (const row of rows) map.set(row.key, [...(map.get(row.key) ?? []), Number(row.id)].sort((a, b) => a - b));
      return map;
    };
    const suppliers = await this.database.query<{ key: string; id: string }>(
      'SELECT lower(ref_key_1c::text) AS key, supplier_id::text AS id FROM suppliers WHERE ref_key_1c IS NOT NULL');
    const sheets = await this.database.query<{ key: string; id: string }>(
      'SELECT lower(ref_key_1c::text) AS key, sheet_material_type_id::text AS id FROM sheet_material_types WHERE ref_key_1c IS NOT NULL');
    const films = await this.database.query<{ key: string; id: string }>(
      'SELECT lower(ref_key_1c::text) AS key, film_id::text AS id FROM films WHERE ref_key_1c IS NOT NULL AND canonical_film_id IS NULL');
    const currencies = await this.database.query<{ key: string; iso_code: string }>(
      'SELECT lower(currency_ref_key::text) AS key, iso_code FROM onec_currency_map WHERE source_id = $1', [sourceId]);
    const source = await this.database.query<{ time_zone: string }>('SELECT time_zone FROM onec_sources WHERE source_id = $1', [sourceId]);
    const description = (data: Record<string, unknown>): string | null =>
      typeof data.Description === 'string' && data.Description.trim() ? data.Description.trim() : null;
    return {
      units: new Map([...units].map(([key, data]) => [key, { code: typeof data.Code === 'string' ? data.Code.trim() : null, name: description(data) }])),
      itemNames: new Map([...items].flatMap(([key, data]) => { const name = description(data); return name ? [[key, name] as const] : []; })),
      counterpartyNames: new Map([...counterparties].flatMap(([key, data]) => { const name = description(data); return name ? [[key, name] as const] : []; })),
      suppliers: group(suppliers.rows),
      sheetMaterials: group(sheets.rows),
      films: group(films.rows),
      currencies: new Map(currencies.rows.map((row) => [row.key, row.iso_code])),
      timeZone: source.rows[0]?.time_zone ?? 'Asia/Almaty',
    };
  }

  /** Без блокировок: отпечатки и признак незавершённого конфликта — отбор документов прохода (устаревание догонит следующий проход). */
  async storedState(sourceId: number, docKinds: readonly OnecDocKind[]): Promise<Map<string, { observed: string | null; blocking: boolean }>> {
    const { rows } = await this.database.query<{ ref: string; observed: string | null; blocking: boolean }>(
      `SELECT lower(d.onec_ref_key::text) AS ref, d.observed_fingerprint AS observed,
              (d.load_conflict ? 'proposedAmount' OR EXISTS (SELECT 1 FROM onec_document_lines l
                 WHERE l.onec_document_id = d.onec_document_id AND l.load_conflict_code IS NOT NULL)) AS blocking
         FROM onec_documents d WHERE d.source_id = $1 AND d.doc_kind = ANY($2::text[])`,
      [sourceId, docKinds],
    );
    return new Map(rows.map((row) => [row.ref, { observed: row.observed, blocking: row.blocking }]));
  }

  /** Целевой отпечаток без транзакции — для отбора (null — документ не разбирается, его обработает loadDocument). */
  previewFingerprint(ctx: LoadContext, data: Record<string, unknown>, missing: boolean, refs: ReferenceData): { refKey: string; docKind: OnecDocKind; fingerprint: string | null } | null {
    // Вид — до разбора и нормализации: документ недействующего вида пропускается при любых ошибках данных (code review R1-3, R2).
    const kind = documentKindOf(ctx.config, data);
    if (kind.ok && !ctx.enabledKinds.has(kind.docKind)) return { refKey: kind.refKey, docKind: kind.docKind, fingerprint: null };
    const parsed = parseDocument(ctx.config, data);
    if (!parsed.ok) return null;
    const target = buildTarget(parsed, refs, missing);
    return { refKey: parsed.header.refKey, docKind: parsed.header.docKind, fingerprint: target.ok ? target.fingerprint : null };
  }

  async loadDocument(ctx: LoadContext, sourceKey: string, refs: ReferenceData): Promise<DocumentOutcome> {
    return this.database.transaction(async (tx) => {
      if (!(await this.reader.lockEntityShare(tx, ctx.sourceId, ctx.entityCode))) return { status: 'skipped', conflicts: 0 };
      const row = (await this.reader.mirrorRows(tx, ctx.sourceId, ctx.entityCode, [sourceKey])).get(sourceKey);
      if (!row) return { status: 'skipped', conflicts: 0 };
      const kind = documentKindOf(ctx.config, row.data);
      if (kind.ok && !ctx.enabledKinds.has(kind.docKind)) return { status: 'skipped', conflicts: 0 };
      const parsed = parseDocument(ctx.config, row.data);
      if (!parsed.ok) return { status: 'invalid', code: parsed.code };
      const target = buildTarget(parsed, refs, row.missing);
      if (!target.ok) return { status: 'invalid', code: target.code };
      const dctx: DocContext = { ...ctx, docKind: parsed.header.docKind };

      // Смена вида в 1С (продажа ↔ возврат поставщику): документ прежнего вида удаляется (§3.2).
      const kindChange = await this.removeOtherKinds(tx, dctx, parsed.header.refKey);
      if (kindChange.refused) return kindChange.refused;
      const outcome = await this.loadCurrentKind(tx, dctx, parsed.header.refKey, target);
      return outcome.status === 'invalid' ? outcome
        : { ...outcome, docKind: dctx.docKind, ...(kindChange.removed.length > 0 ? { removed: kindChange.removed } : {}) };
    });
  }

  /** Загрузка документа текущего вида: вставка или применение к существующему (шапка и строки под блокировками). */
  private async loadCurrentKind(
    tx: DatabaseClient,
    ctx: DocContext,
    refKey: string,
    target: { header: TargetHeader; lines: TargetLine[]; fingerprint: string },
  ): Promise<DocumentOutcome> {
    let header = await this.lockHeader(tx, ctx, refKey);
    if (!header) {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec,
           counterparty_ref_key, counterparty_name, supplier_id, amount, currency, comment, source_updated_at,
           missing_in_source_at, mapping_issue, observed_fingerprint, applied_revision,
           operation_kind, doc_at, warehouse_ref_key, destination_warehouse_ref_key, normalizer_version)
         VALUES ($1, $2, $3::uuid, $4, $5::date, $6, $7, $8::uuid, $9, $10, $11::numeric, $12, $13, now(),
           CASE WHEN $14 THEN now() END, $15, $16, 0,
           $17, ($18::timestamp AT TIME ZONE $19::text), $20::uuid, $21::uuid, $22)
         ON CONFLICT (source_id, doc_kind, onec_ref_key) DO NOTHING
         RETURNING onec_document_id::text AS id`,
        [ctx.sourceId, ctx.docKind, refKey, ...this.headerValues(target.header), target.fingerprint,
          ...this.v2HeaderValues(target.header), NORMALIZER_VERSION],
      );
      if (inserted.rows[0]) return this.finishNew(tx, ctx, Number(inserted.rows[0].id), refKey, target.header, target.lines);
      header = await this.lockHeader(tx, ctx, refKey);
      if (!header) throw new Error('onec_documents row vanished during insert');
    }
    const outcome = await this.applyExisting(tx, ctx, header, refKey, target.header, target.lines, target.fingerprint);
    return outcome.status === 'invalid' ? outcome : { ...outcome, documentId: Number(header.onec_document_id) };
  }

  private async lockHeader(tx: DatabaseClient, ctx: DocContext, refKey: string): Promise<HeaderRow | null> {
    return (await tx.query<HeaderRow>(
      `${HEADER_SELECT} WHERE source_id = $1 AND doc_kind = $2 AND onec_ref_key = $3::uuid FOR NO KEY UPDATE`,
      [ctx.sourceId, ctx.docKind, refKey],
    )).rows[0] ?? null;
  }

  /** Поля, добавленные в v2: вид операции, момент (локальное время + пояс источника), склады. */
  private v2HeaderValues(header: TargetHeader): unknown[] {
    return [header.operationKind, header.docAtLocal, header.timeZone, header.warehouseRefKey, header.destinationWarehouseRefKey];
  }

  /**
   * Документы того же `Ref_Key` другого вида этой сущности (смена `ВидОперации` в 1С): удаляются физически вместе со
   * строками — с аудитом и событием; строка, на которую ссылается потребитель, не удаляется — документ остаётся,
   * проход отмечает `KIND_CHANGE_REFERENCED`. null — других видов нет (или все удалены).
   */
  private async removeOtherKinds(
    tx: DatabaseClient,
    ctx: DocContext,
    refKey: string,
  ): Promise<{ refused: DocumentOutcome | null; removed: Array<{ documentId: number; docKind: OnecDocKind }> }> {
    const removed: Array<{ documentId: number; docKind: OnecDocKind }> = [];
    const others = entityDocKinds(ctx.config).filter((kind) => kind !== ctx.docKind);
    if (others.length === 0) return { refused: null, removed };
    const stale = (await tx.query<HeaderRow>(
      `${HEADER_SELECT} WHERE source_id = $1 AND doc_kind = ANY($2::text[]) AND onec_ref_key = $3::uuid
        ORDER BY onec_document_id FOR NO KEY UPDATE`,
      [ctx.sourceId, others, refKey],
    )).rows;
    for (const header of stale) {
      const documentId = Number(header.onec_document_id);
      const lines = (await tx.query<LineRow>(
        `${LINE_SELECT} WHERE onec_document_id = $1 ORDER BY onec_document_lines.onec_document_line_id FOR UPDATE`, [documentId])).rows;
      const ids = lines.map((line) => Number(line.onec_document_line_id));
      for (const consumer of this.consumers.forKind(header.doc_kind)) {
        if ((await consumer.referencedLineIds(tx, ids)).size > 0) return { refused: { status: 'invalid', code: 'KIND_CHANGE_REFERENCED' }, removed: [] };
      }
      await tx.query('DELETE FROM onec_document_lines WHERE onec_document_id = $1', [documentId]);
      await tx.query('DELETE FROM onec_documents WHERE onec_document_id = $1', [documentId]);
      const revision = Number(header.applied_revision) + 1;
      await auditService.record(tx, {
        event: 'onec.document.removed',
        entityType: 'onec_document',
        entityId: documentId,
        actorUserId: null,
        actorUsername: null,
        actorRole: null,
        requestId: ctx.requestId,
        source: SOURCE,
        statusField: 'posted',
        statusCode: header.posted ? 'posted' : 'unposted',
        stageCode: 'kind_changed',
        before: { ...this.headerSnapshot(header, lines.length), lines: lines.map(lineAudit) },
        after: null,
        diff: { docKind: { from: header.doc_kind, to: ctx.docKind } },
        metadata: {
          sourceId: ctx.sourceId, docKind: header.doc_kind, newDocKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision,
          runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, reason: 'kind_changed', onecRefKey: refKey,
        },
      });
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('onec.document_changed', 'onec_document', $1, $2::jsonb, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [String(documentId), JSON.stringify({
          eventId: randomUUID(), eventType: 'onec.document_changed', documentId, docKind: header.doc_kind, sourceId: ctx.sourceId,
          revision, runId: ctx.runId, requestId: ctx.requestId, correlationId: ctx.correlationId, occurredAt: new Date().toISOString(),
          removed: true, reason: 'kind_changed', newDocKind: ctx.docKind, linesChanged: ids,
        }), `onec_document:${documentId}:${revision}`],
      );
      await this.alerts.resolve(tx, `${CONFLICT_ALERT_KIND}:${documentId}`);
      removed.push({ documentId, docKind: header.doc_kind });
    }
    return { refused: null, removed };
  }

  private headerValues(header: TargetHeader): unknown[] {
    return [header.number, header.docDate, header.posted, header.deletedInOnec, header.counterpartyRefKey, header.counterpartyName,
      header.supplierId, header.amount, header.currency, header.comment, header.missingInSource, header.mappingIssue];
  }

  private async insertLine(tx: DatabaseClient, documentId: number, line: TargetLine): Promise<number> {
    return Number((await tx.query<{ id: string }>(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_ref_key, nomenclature_name, quantity, unit_name,
         unit_code, price, amount, is_document_total, sheet_material_type_id, film_id, onec_order_ref_key, mapping_issue,
         warehouse_ref_key, is_stock_item, unit_is_package)
       VALUES ($1, $2, $3::uuid, $4, $5::numeric, $6, $7, $8::numeric, $9::numeric, $10, $11, $12, $13::uuid, $14, $15::uuid, $16, $17)
       RETURNING onec_document_line_id::text AS id`,
      [documentId, line.lineNo, line.nomenclatureRefKey, line.nomenclatureName, line.quantity, line.unitName, line.unitCode,
        line.price, line.amount, line.isDocumentTotal, line.sheetMaterialTypeId, line.filmId, line.onecOrderRefKey, line.mappingIssue,
        line.warehouseRefKey, line.isStockItem, line.unitIsPackage],
    )).rows[0].id);
  }

  private async finishNew(tx: DatabaseClient, ctx: DocContext, documentId: number, refKey: string, header: TargetHeader, lines: TargetLine[]): Promise<DocumentOutcome> {
    for (const line of lines) await this.insertLine(tx, documentId, line);
    const state = await this.readState(tx, documentId);
    await this.commitRevision(tx, ctx, refKey, state, null, [], {
      created: true, conflicts: [], linesChanged: state.lines.map((l) => Number(l.onec_document_line_id)),
    });
    return { status: 'created', conflicts: 0, documentId };
  }

  private async readState(tx: DatabaseClient, documentId: number): Promise<{ header: HeaderRow; lines: LineRow[] }> {
    const header = (await tx.query<HeaderRow>(`${HEADER_SELECT} WHERE onec_document_id = $1`, [documentId])).rows[0];
    const lines = (await tx.query<LineRow>(`${LINE_SELECT} WHERE onec_document_id = $1 ORDER BY line_no, onec_document_lines.onec_document_line_id`, [documentId])).rows;
    return { header, lines };
  }

  private async applyExisting(
    tx: DatabaseClient,
    ctx: DocContext,
    header: HeaderRow,
    refKey: string,
    target: TargetHeader,
    targetLines: TargetLine[],
    fingerprint: string,
  ): Promise<DocumentOutcome> {
    const documentId = Number(header.onec_document_id);
    // Все строки документа по возрастанию id — даже если меняется только шапка (R1-1, ответ закупок).
    const lines = (await tx.query<LineRow>(
      `${LINE_SELECT} WHERE onec_document_id = $1 ORDER BY onec_document_lines.onec_document_line_id FOR NO KEY UPDATE`, [documentId])).rows;
    const blocking = lines.some((line) => line.load_conflict_code !== null) || (header.load_conflict?.proposedAmount ?? null) !== null;
    if (header.observed_fingerprint === fingerprint && !blocking) return { status: 'unchanged', conflicts: 0 };

    // 1. Изменения строк относительно целевого состояния.
    const current = new Map(lines.map((line) => [line.line_no, line]));
    const wanted = new Map(targetLines.map((line) => [line.lineNo, line]));

    // Переход правил v1 → v2 (план §3.2, R2-2): применённое v1-состояние отличается от целевого только полями v2
    // (вид операции, момент, склады, признаки строк) — техническое обновление: оба отпечатка, без ревизии, аудита и outbox.
    if (header.normalizer_version !== NORMALIZER_VERSION && !blocking && this.sameV1State(header, lines, target, targetLines)) {
      await tx.query(
        `UPDATE onec_documents SET operation_kind = $2, doc_at = ($3::timestamp AT TIME ZONE $4::text), warehouse_ref_key = $5::uuid,
           destination_warehouse_ref_key = $6::uuid, normalizer_version = $7, observed_fingerprint = $8
         WHERE onec_document_id = $1`,
        [documentId, ...this.v2HeaderValues(target), NORMALIZER_VERSION, fingerprint],
      );
      for (const line of targetLines) {
        await tx.query(
          'UPDATE onec_document_lines SET warehouse_ref_key = $2::uuid, is_stock_item = $3, unit_is_package = $4 WHERE onec_document_line_id = $1',
          [current.get(line.lineNo)!.onec_document_line_id, line.warehouseRefKey, line.isStockItem, line.unitIsPackage],
        );
      }
      const upgraded = await this.readState(tx, documentId);
      await tx.query('UPDATE onec_documents SET applied_fingerprint = $2 WHERE onec_document_id = $1', [documentId, this.appliedFingerprint(upgraded)]);
      // Аудит перехода — в транзакции документа (code review R1-1): сбой после commit не теряет запись; ревизии и outbox нет.
      await auditService.record(tx, {
        event: 'onec.document.normalizer_upgraded',
        entityType: 'onec_document',
        entityId: documentId,
        actorUserId: null,
        actorUsername: null,
        actorRole: null,
        requestId: ctx.requestId,
        source: SOURCE,
        statusField: 'posted',
        statusCode: upgraded.header.posted ? 'posted' : 'unposted',
        stageCode: 'normalizer_upgraded',
        before: { normalizerVersion: header.normalizer_version },
        after: {
          normalizerVersion: NORMALIZER_VERSION, docAt: upgraded.header.doc_at, operationKind: upgraded.header.operation_kind,
          warehouseRefKey: upgraded.header.warehouse_ref_key, lines: upgraded.lines.map((line) => ({
            lineNo: line.line_no, warehouseRefKey: line.warehouse_ref_key, isStockItem: line.is_stock_item, unitIsPackage: line.unit_is_package,
          })),
        },
        diff: { normalizerVersion: { from: header.normalizer_version, to: NORMALIZER_VERSION } },
        metadata: {
          sourceId: ctx.sourceId, docKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision: Number(header.applied_revision),
          runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, normalizerVersion: NORMALIZER_VERSION,
        },
      });
      return { status: 'upgraded', conflicts: 0 };
    }
    const changes: DocumentLineChange[] = [];
    for (const line of targetLines) {
      const row = current.get(line.lineNo);
      if (!row) changes.push({ lineId: null, lineNo: line.lineNo, kind: 'insert', before: null, after: stateOfTarget(line) });
      else if (!lineMatches(row, line) || row.removed_in_onec_at !== null || row.load_conflict_code !== null) {
        changes.push({ lineId: Number(row.onec_document_line_id), lineNo: line.lineNo, kind: 'update', before: stateOfRow(row), after: stateOfTarget(line) });
      }
    }
    for (const row of lines) {
      if (!wanted.has(row.line_no)) {
        changes.push({ lineId: Number(row.onec_document_line_id), lineNo: row.line_no, kind: 'remove', before: stateOfRow(row), after: null });
      }
    }

    // 2. Проверки потребителей (под блокировками шапки и строк).
    const view: LoadedDocumentView = {
      documentId, sourceId: ctx.sourceId, docKind: ctx.docKind, onecRefKey: refKey, docDate: target.docDate,
      posted: target.posted, deletedInOnec: target.deletedInOnec, supplierId: target.supplierId,
      counterpartyRefKey: target.counterpartyRefKey, counterpartyName: target.counterpartyName, amount: target.amount,
    };
    const consumers = this.consumers.forKind(ctx.docKind);
    const conflicts = new Map<number, LineConflictCode>();
    for (const consumer of consumers) {
      for (const conflict of await consumer.guardLineChanges(tx, view, changes)) {
        if (!conflicts.has(conflict.lineNo)) conflicts.set(conflict.lineNo, conflict.code);
      }
    }
    const removedIds = changes.filter((change) => change.kind === 'remove').map((change) => change.lineId!);
    const referenced = new Set<number>();
    for (const consumer of consumers) for (const id of await consumer.referencedLineIds(tx, removedIds)) referenced.add(id);

    // 3. Шапка. Поле, ограничивающее существующие распределения (сумма оплаты), при конфликте не меняется (R3-1).
    const amountConflict = [...conflicts.values()].includes('AMOUNT_BELOW_ALLOCATED');
    const conflictDetails = changes.filter((change) => conflicts.has(change.lineNo)).map((change) => ({
      lineNo: change.lineNo, lineId: change.lineId, code: conflicts.get(change.lineNo)!, before: change.before, after: change.after,
    }));
    const loadConflict = conflictDetails.length > 0 || target.missingInSource
      ? { lines: conflictDetails, missingInSource: target.missingInSource, proposedAmount: amountConflict ? target.amount : null }
      : null;
    await tx.query(
      `UPDATE onec_documents SET number = $2, doc_date = $3::date, posted = $4, deleted_in_onec = $5, counterparty_ref_key = $6::uuid,
         counterparty_name = $7, supplier_id = $8, amount = CASE WHEN $15 THEN amount ELSE $9::numeric END, currency = $10, comment = $11,
         missing_in_source_at = CASE WHEN $12 THEN COALESCE(missing_in_source_at, now()) END, mapping_issue = $13,
         observed_fingerprint = $14, load_conflict = $16::jsonb, source_updated_at = now(), updated_at = now(),
         operation_kind = $17, doc_at = ($18::timestamp AT TIME ZONE $19::text), warehouse_ref_key = $20::uuid,
         destination_warehouse_ref_key = $21::uuid, normalizer_version = $22
       WHERE onec_document_id = $1`,
      [documentId, ...this.headerValues(target), fingerprint, amountConflict, loadConflict === null ? null : JSON.stringify(loadConflict),
        ...this.v2HeaderValues(target), NORMALIZER_VERSION],
    );

    // 4. Строки.
    const insertedIds: number[] = [];
    for (const change of changes) {
      const code = conflicts.get(change.lineNo) ?? null;
      if (change.kind === 'insert') {
        insertedIds.push(await this.insertLine(tx, documentId, wanted.get(change.lineNo)!));
      } else if (change.kind === 'update') {
        if (code !== null) {
          // Конфликт: прежние значения остаются, новые — в load_conflict документа; новые распределения запрещены.
          // Строка есть в документе 1С — признак удаления снимается и при конфликте (R1-2, code review R4).
          await tx.query('UPDATE onec_document_lines SET load_conflict_code = $2, removed_in_onec_at = NULL WHERE onec_document_line_id = $1', [change.lineId, code]);
        } else {
          const line = wanted.get(change.lineNo)!;
          await tx.query(
            `UPDATE onec_document_lines SET nomenclature_ref_key = $2::uuid, nomenclature_name = $3, quantity = $4::numeric, unit_name = $5,
               unit_code = $6, price = $7::numeric, amount = $8::numeric, is_document_total = $9, sheet_material_type_id = $10, film_id = $11,
               onec_order_ref_key = $12::uuid, mapping_issue = $13, removed_in_onec_at = NULL, load_conflict_code = NULL,
               warehouse_ref_key = $14::uuid, is_stock_item = $15, unit_is_package = $16
             WHERE onec_document_line_id = $1`,
            [change.lineId, line.nomenclatureRefKey, line.nomenclatureName, line.quantity, line.unitName, line.unitCode, line.price,
              line.amount, line.isDocumentTotal, line.sheetMaterialTypeId, line.filmId, line.onecOrderRefKey, line.mappingIssue,
              line.warehouseRefKey, line.isStockItem, line.unitIsPackage],
          );
        }
      } else if (code !== null || referenced.has(change.lineId!)) {
        // Исчезла в 1С, но на неё есть ссылки распределений (R1-2): остаётся с признаком.
        await tx.query(
          'UPDATE onec_document_lines SET removed_in_onec_at = COALESCE(removed_in_onec_at, now()), load_conflict_code = $2 WHERE onec_document_line_id = $1',
          [change.lineId, code],
        );
      } else {
        await tx.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR UPDATE', [change.lineId]);
        await tx.query('DELETE FROM onec_document_lines WHERE onec_document_line_id = $1', [change.lineId]);
      }
    }

    // 5. Ревизия, аудит, outbox, потребители — только если изменилось применённое состояние или конфликты (R2-2).
    const state = await this.readState(tx, documentId);
    const changed = await this.commitRevision(tx, ctx, refKey, state, header, lines, {
      created: false,
      conflicts: conflictDetails.map((detail) => ({ lineNo: detail.lineNo, code: detail.code })),
      linesChanged: [...changes.filter((change) => change.lineId !== null).map((change) => change.lineId!), ...insertedIds].sort((a, b) => a - b),
    });
    return { status: changed ? 'changed' : 'unchanged', conflicts: conflictDetails.length };
  }

  /** Применённое v1-состояние совпадает с целевым по всем полям v1 (без конфликтов, пропажи и удалённых строк). */
  private sameV1State(header: HeaderRow, lines: LineRow[], target: TargetHeader, targetLines: TargetLine[]): boolean {
    if (header.load_conflict !== null || header.missing_in_source_at !== null || target.missingInSource) return false;
    const sameHeader = header.number === target.number && header.doc_date === target.docDate && header.posted === target.posted
      && header.deleted_in_onec === target.deletedInOnec && header.counterparty_ref_key === target.counterpartyRefKey
      && header.counterparty_name === target.counterpartyName && num(header.supplier_id) === target.supplierId
      && sameNumber(header.amount, target.amount) && header.currency === target.currency && header.comment === target.comment
      && header.mapping_issue === target.mappingIssue;
    if (!sameHeader || lines.length !== targetLines.length) return false;
    const byNo = new Map(lines.map((row) => [row.line_no, row]));
    return targetLines.every((line) => {
      const row = byNo.get(line.lineNo);
      return row !== undefined && row.removed_in_onec_at === null && row.load_conflict_code === null && lineMatches(row, line, false);
    });
  }

  /** Снимок шапки для аудита. */
  private headerSnapshot(row: HeaderRow, lineCount: number | null) {
    return {
      docKind: row.doc_kind, operationKind: row.operation_kind, docAt: row.doc_at, warehouseRefKey: row.warehouse_ref_key,
      destinationWarehouseRefKey: row.destination_warehouse_ref_key,
      number: row.number, docDate: row.doc_date, posted: row.posted, deletedInOnec: row.deleted_in_onec, amount: row.amount,
      supplierId: row.supplier_id === null ? null : Number(row.supplier_id), missingInSource: row.missing_in_source_at !== null,
      mappingIssue: row.mapping_issue, currency: row.currency, comment: row.comment, counterpartyRefKey: row.counterparty_ref_key,
      counterpartyName: row.counterparty_name,
      // Полное состояние конфликта: строки до/после и предложенная 1С сумма (R2 code review).
      loadConflict: row.load_conflict, ...(lineCount === null ? {} : { lines: lineCount }),
    };
  }

  /** Отпечаток применённого состояния: шапка + строки + конфликты. */
  private appliedFingerprint(state: { header: HeaderRow; lines: LineRow[] }): string {
    const { header } = state;
    return createHash('sha256').update(JSON.stringify({
      header: [header.number, header.doc_date, header.posted, header.deleted_in_onec, header.counterparty_ref_key, header.counterparty_name,
        header.supplier_id, header.amount, header.currency, header.comment, header.missing_in_source_at !== null, header.mapping_issue,
        header.load_conflict, header.doc_kind, header.operation_kind, header.doc_at, header.warehouse_ref_key,
        header.destination_warehouse_ref_key],
      lines: state.lines.map((line) => [line.onec_document_line_id, line.line_no, line.nomenclature_ref_key, line.nomenclature_name,
        line.quantity, line.unit_name, line.unit_code, line.price, line.amount, line.is_document_total, line.sheet_material_type_id,
        line.film_id, line.onec_order_ref_key, line.removed_in_onec_at !== null, line.load_conflict_code, line.mapping_issue,
        line.warehouse_ref_key, line.is_stock_item, line.unit_is_package]),
    })).digest('hex');
  }

  private async commitRevision(
    tx: DatabaseClient,
    ctx: DocContext,
    refKey: string,
    state: { header: HeaderRow; lines: LineRow[] },
    before: HeaderRow | null,
    beforeLines: LineRow[],
    info: { created: boolean; conflicts: Array<{ lineNo: number; code: LineConflictCode }>; linesChanged: number[] },
  ): Promise<boolean> {
    const applied = this.appliedFingerprint(state);
    if (before && before.applied_fingerprint === applied) return false;
    const documentId = Number(state.header.onec_document_id);
    const revision = Number((await tx.query<{ revision: string }>(
      `UPDATE onec_documents SET applied_fingerprint = $2, applied_revision = applied_revision + 1
        WHERE onec_document_id = $1 RETURNING applied_revision::text AS revision`,
      [documentId, applied],
    )).rows[0].revision);
    const header = state.header;
    const snapshot = (row: HeaderRow | null, lineCount: number | null) => row === null ? null : this.headerSnapshot(row, lineCount);
    const event = info.created ? 'onec.document.loaded' : info.conflicts.length > 0 ? 'onec.document.conflict' : 'onec.document.changed';
    // Построчная история (Р13): применённое состояние строк до и после, изменения полей шапки и строк.
    const beforeByLine = new Map(beforeLines.map((row) => [row.line_no, lineAudit(row)]));
    const afterByLine = new Map(state.lines.map((row) => [row.line_no, lineAudit(row)]));
    const lineDiff = [...new Set([...beforeByLine.keys(), ...afterByLine.keys()])].sort((a, b) => a - b).flatMap((lineNo): Array<Record<string, unknown>> => {
      const from = beforeByLine.get(lineNo) ?? null;
      const to = afterByLine.get(lineNo) ?? null;
      if (from && to) {
        const fields = (Object.keys(to) as Array<keyof typeof to>).filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]));
        return fields.length === 0 ? [] : [{ lineNo, change: 'updated', fields: Object.fromEntries(fields.map((key) => [key, { from: from[key], to: to[key] }])) }];
      }
      return [{ lineNo, change: from ? 'deleted' : 'inserted', ...(from ? { before: from } : { after: to }) }];
    });
    const headerBefore = snapshot(before, null);
    const headerAfter = snapshot(header, state.lines.length)!;
    const headerDiff = headerBefore === null ? {} : Object.fromEntries(Object.entries(headerAfter)
      .filter(([key, value]) => key !== 'lines' && JSON.stringify((headerBefore as Record<string, unknown>)[key]) !== JSON.stringify(value))
      .map(([key, value]) => [key, { from: (headerBefore as Record<string, unknown>)[key], to: value }]));
    await auditService.record(tx, {
      event,
      entityType: 'onec_document',
      entityId: documentId,
      actorUserId: null,
      actorUsername: null,
      actorRole: null,
      requestId: ctx.requestId,
      source: SOURCE,
      statusField: 'posted',
      statusCode: header.posted ? 'posted' : 'unposted',
      stageCode: info.created ? 'created' : info.conflicts.length > 0 ? 'conflict' : 'changed',
      before: headerBefore === null ? null : { ...headerBefore, lines: beforeLines.map(lineAudit) },
      after: { ...headerAfter, lines: state.lines.map(lineAudit), conflicts: info.conflicts },
      diff: { header: headerDiff, lines: lineDiff },
      metadata: {
        sourceId: ctx.sourceId, docKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision,
        runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, linesChanged: info.linesChanged,
      },
    });
    const payload = {
      eventId: randomUUID(), eventType: 'onec.document_changed', documentId, docKind: ctx.docKind, sourceId: ctx.sourceId,
      revision, runId: ctx.runId, requestId: ctx.requestId, correlationId: ctx.correlationId, occurredAt: new Date().toISOString(),
      created: info.created,
      postedChanged: before !== null && before.posted !== header.posted,
      nowUnposted: before !== null && before.posted && !header.posted,
      deletedInOnec: header.deleted_in_onec,
      missingInSource: header.missing_in_source_at !== null,
      linesChanged: info.linesChanged,
      conflict: info.conflicts.length > 0,
    };
    // Общая бизнес-очередь (не onec_outbox_events — её relay знает только события транспорта 1С).
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('onec.document_changed', 'onec_document', $1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [String(documentId), JSON.stringify(payload), `onec_document:${documentId}:${revision}`],
    );
    const dedupeKey = `${CONFLICT_ALERT_KIND}:${documentId}`;
    if (info.conflicts.length > 0) {
      await this.alerts.raise(tx, {
        kind: CONFLICT_ALERT_KIND, sourceId: ctx.sourceId, dedupeKey, severity: 'warning',
        details: { documentId, docKind: ctx.docKind, number: header.number, conflicts: info.conflicts },
      });
    } else {
      await this.alerts.resolve(tx, dedupeKey);
    }
    // Потребители — по согласованному состоянию (R3-2): применённые строки без конфликта и не удалённые в 1С.
    const appliedLines: AppliedDocumentLine[] = state.lines
      .filter((line) => line.load_conflict_code === null && line.removed_in_onec_at === null)
      .map((line) => ({ lineId: Number(line.onec_document_line_id), ...stateOfRow(line) }));
    const view: LoadedDocumentView = {
      documentId, sourceId: ctx.sourceId, docKind: ctx.docKind, onecRefKey: refKey, docDate: header.doc_date,
      posted: header.posted, deletedInOnec: header.deleted_in_onec, supplierId: header.supplier_id === null ? null : Number(header.supplier_id),
      counterpartyRefKey: header.counterparty_ref_key, counterpartyName: header.counterparty_name, amount: header.amount,
    };
    for (const consumer of this.consumers.forKind(ctx.docKind)) {
      await consumer.afterDocumentLoaded(tx, view, {
        appliedLines,
        conflictedLines: state.lines.filter((line) => line.load_conflict_code !== null)
          .map((line) => ({ lineId: Number(line.onec_document_line_id), lineNo: line.line_no, code: line.load_conflict_code! })),
        removedLines: state.lines.filter((line) => line.removed_in_onec_at !== null)
          .map((line) => ({ lineId: Number(line.onec_document_line_id), lineNo: line.line_no })),
      });
    }
    return true;
  }
}
