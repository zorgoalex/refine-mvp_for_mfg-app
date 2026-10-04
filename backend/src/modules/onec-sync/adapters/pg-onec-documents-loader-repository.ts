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
  auditRefsOf,
  buildTarget,
  documentKindOf,
  entityDocKinds,
  NORMALIZER_VERSION,
  parseDocument,
  PREVIOUS_NORMALIZER_VERSION,
  type AuditOnecRef,
  type DocumentEntityConfig,
  type LineSection,
  type OnecDocKind,
  type OnecUnitCode,
  type ReferenceData,
  type TargetCustomerOrder,
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
  | { status: 'invalid'; code: string; removed?: Array<{ documentId: number; docKind: OnecDocKind }> };

/** Документ ERP одного ключа 1С (для отбора прохода, §3.6 R2-2). */
export interface StoredDoc {
  kind: OnecDocKind;
  observed: string | null;
  blocking: boolean;
  /** Вид, в который документ ушёл в 1С (снят с вида); null — действует. */
  leftKindTo: OnecDocKind | null;
}

/** Документы ERP по ключу 1С (нижний регистр); у одного ключа — по одному на вид. */
export type StoredState = Map<string, StoredDoc[]>;

/**
 * Решение прохода по документу копии без транзакции (§3.6 R2-2): `unchanged` — только документ того же вида, не снятый
 * с вида, без конфликтов, с тем же отпечатком, и нет записей другого вида, ждущих обработки; `skip` — вид выключен и
 * обрабатывать нечего; иначе `load` (транзакция документа).
 */
export function passDecision(
  stored: readonly StoredDoc[] | undefined,
  preview: { docKind: OnecDocKind; fingerprint: string | null; enabled: boolean },
): 'unchanged' | 'skip' | 'load' {
  const docs = stored ?? [];
  const othersPending = docs.some((doc) => doc.kind !== preview.docKind && !(doc.leftKindTo === preview.docKind && !doc.blocking));
  if (!preview.enabled) return othersPending ? 'load' : 'skip';
  const own = docs.find((doc) => doc.kind === preview.docKind);
  if (!othersPending && own && preview.fingerprint !== null && own.observed === preview.fingerprint && !own.blocking && own.leftKindTo === null) {
    return 'unchanged';
  }
  return 'load';
}

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
  load_conflict: { proposedAmount?: string | null; proposedCurrency?: string | null; kindChangedTo?: OnecDocKind } | null;
  missing_in_source_at: Date | null;
  mapping_issue: string | null;
  author_ref_key: string | null;
  author_name: string | null;
  responsible_ref_key: string | null;
  responsible_name: string | null;
  onec_order_ref_key: string | null;
  basis_ref_key: string | null;
  basis_type: string | null;
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
  line_section: LineSection;
  settlement_doc_ref_key: string | null;
  settlement_doc_type: string | null;
  is_advance: boolean;
  content: string | null;
  line_shipment_date: string | null;
}

/** Реквизиты заказа покупателя (onec_customer_orders) в виде, сравнимом с целевым. */
interface OrderRow extends QueryResultRow {
  state_ref_key: string | null;
  state_name: string | null;
  order_kind_ref_key: string | null;
  order_kind_name: string | null;
  payment_status: string | null;
  production_status: string | null;
  completion_variant: string | null;
  delivery_method: string | null;
  shipment_date: string | null;
  delivery_address: string | null;
  delivery_service_ref_key: string | null;
  delivery_service_name: string | null;
  expected_delivery_date: string | null;
  sales_unit_ref_key: string | null;
  workshop_ref_key: string | null;
  contract_ref_key: string | null;
  onec_changed_at: string | null;
}

interface DocumentState {
  header: HeaderRow;
  lines: LineRow[];
  /** Реквизиты заказа покупателя; null — не заказ (или ещё не записаны). */
  order: OrderRow | null;
}

const HEADER_SELECT = `SELECT onec_document_id::text, doc_kind,
  to_char(doc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS doc_at, operation_kind, warehouse_ref_key::text,
  destination_warehouse_ref_key::text, normalizer_version, number, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, posted, deleted_in_onec,
  counterparty_ref_key::text, counterparty_name, supplier_id::text, amount::text, currency, comment, observed_fingerprint,
  applied_fingerprint, applied_revision::text, load_conflict, missing_in_source_at, mapping_issue,
  author_ref_key::text, author_name, responsible_ref_key::text, responsible_name, onec_order_ref_key::text, basis_ref_key::text, basis_type
  FROM onec_documents`;
const LINE_SELECT = `SELECT onec_document_line_id::text, line_no, nomenclature_ref_key::text, nomenclature_name, quantity::text,
  unit_name, unit_code, price::text, amount::text, is_document_total, sheet_material_type_id::text, film_id::text,
  onec_order_ref_key::text, removed_in_onec_at, load_conflict_code, mapping_issue, warehouse_ref_key::text, is_stock_item,
  unit_is_package, line_section, settlement_doc_ref_key::text, settlement_doc_type, is_advance, content,
  to_char(line_shipment_date, 'YYYY-MM-DD') AS line_shipment_date
  FROM onec_document_lines`;
const ORDER_SELECT = `SELECT state_ref_key::text, state_name, order_kind_ref_key::text, order_kind_name, payment_status, production_status,
  completion_variant, delivery_method, to_char(shipment_date, 'YYYY-MM-DD') AS shipment_date, delivery_address,
  delivery_service_ref_key::text, delivery_service_name, to_char(expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date,
  sales_unit_ref_key::text, workshop_ref_key::text, contract_ref_key::text,
  to_char(onec_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS onec_changed_at
  FROM onec_customer_orders`;

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

/**
 * Строка в БД совпадает с целевой по полям версий правил до `level` включительно: 1 — исходные, 2 — склад и признаки
 * строки, 3 — раздел, ссылки заказа/документа зачёта, аванс, содержание, дата отгрузки строки (план 2026-10-02 §3.3).
 */
function lineMatches(row: LineRow, line: TargetLine, level: 1 | 2 | 3 = 3): boolean {
  if (level >= 2 && (row.warehouse_ref_key !== line.warehouseRefKey || row.is_stock_item !== line.isStockItem
    || row.unit_is_package !== line.unitIsPackage)) return false;
  if (level >= 3 && (row.line_section !== line.section || row.settlement_doc_ref_key !== line.settlementDocRefKey
    || row.settlement_doc_type !== line.settlementDocType || row.is_advance !== line.isAdvance || row.content !== line.content
    || row.line_shipment_date !== line.lineShipmentDate || row.onec_order_ref_key !== line.onecOrderRefKey)) return false;
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
    section: row.line_section, settlementDocRefKey: row.settlement_doc_ref_key, settlementDocType: row.settlement_doc_type,
    isAdvance: row.is_advance, content: row.content, lineShipmentDate: row.line_shipment_date,
  };
}

/**
 * Ссылки 1С применённого состояния (для onec_document_audit_refs). У заказа покупателя — и собственный ключ (роль
 * `customer_order`): история заказа ищется по одному ключу вместе со ссылающимися документами (code review R1-4).
 */
function auditRefsOfState(state: { header: HeaderRow; lines: LineRow[] } | null, refKey: string): AuditOnecRef[] {
  if (state === null) return [];
  const own: AuditOnecRef[] = state.header.doc_kind === 'customer_order'
    ? [{ role: 'customer_order', refKey: refKey.toLowerCase(), type: 'Document_ЗаказПокупателя' }] : [];
  return [...own, ...auditRefsOf(
    { onecOrderRefKey: state.header.onec_order_ref_key, basisRefKey: state.header.basis_ref_key, basisType: state.header.basis_type },
    state.lines.map((line) => ({ onecOrderRefKey: line.onec_order_ref_key, settlementDocRefKey: line.settlement_doc_ref_key, settlementDocType: line.settlement_doc_type })),
  ).filter((ref) => !own.some((mine) => mine.role === ref.role && mine.refKey === ref.refKey))];
}

/** Реквизиты заказа покупателя для аудита/события (имена ключей ERP). */
function orderAudit(order: OrderRow | null) {
  if (order === null) return null;
  return {
    stateRefKey: order.state_ref_key, stateName: order.state_name, orderKindRefKey: order.order_kind_ref_key, orderKindName: order.order_kind_name,
    paymentStatus: order.payment_status, productionStatus: order.production_status, completionVariant: order.completion_variant,
    deliveryMethod: order.delivery_method, shipmentDate: order.shipment_date, deliveryAddress: order.delivery_address,
    deliveryServiceRefKey: order.delivery_service_ref_key, deliveryServiceName: order.delivery_service_name,
    expectedDeliveryDate: order.expected_delivery_date, salesUnitRefKey: order.sales_unit_ref_key, workshopRefKey: order.workshop_ref_key,
    contractRefKey: order.contract_ref_key, onecChangedAt: order.onec_changed_at,
  };
}

type EventAction = 'loaded' | 'changed' | 'conflict' | 'removed' | 'kind_changed';

/** Заказы покупателя, на которые ссылается документ (шапка и строки, не снятые). */
function orderRefsOf(state: DocumentState): string[] {
  const refs = new Set<string>();
  if (state.header.onec_order_ref_key) refs.add(state.header.onec_order_ref_key);
  for (const line of state.lines) if (line.onec_order_ref_key && line.removed_in_onec_at === null) refs.add(line.onec_order_ref_key);
  return [...refs].sort();
}

function orderStateOf(state: DocumentState | null) {
  if (state === null) return null;
  return {
    stateRefKey: state.order?.state_ref_key ?? null, stateName: state.order?.state_name ?? null,
    paymentStatus: state.order?.payment_status ?? null, productionStatus: state.order?.production_status ?? null,
    posted: state.header.posted, deletedInOnec: state.header.deleted_in_onec,
  };
}

/**
 * Контекст события outbox (план 2026-10-02 §10, R1-4): системный актор, действие, сущность, для заказа — состояние до/после,
 * для остальных — заказы до/после. Каждая ревизия — своё событие, поэтому переходы не теряются.
 */
function eventContext(ctx: DocContext, action: EventAction, refKey: string, before: DocumentState | null, after: DocumentState | null) {
  const current = after ?? before!;
  return {
    actor: { type: 'system', source: SOURCE },
    action,
    entityCode: ctx.entityCode,
    onecRefKey: refKey,
    number: current.header.number,
    ...(ctx.docKind === 'customer_order'
      ? { orderState: { before: orderStateOf(before), after: orderStateOf(after) } }
      : { orderRefs: { before: before === null ? null : orderRefsOf(before), after: after === null ? null : orderRefsOf(after) } }),
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
    const [units, items, counterparties, users, employees, orderStates, orderKinds, deliveryServices] = await Promise.all([
      this.reader.entityData(sourceId, 'units'),
      this.reader.entityData(sourceId, 'items'),
      this.reader.entityData(sourceId, 'counterparties'),
      this.reader.entityData(sourceId, 'users'),
      this.reader.entityData(sourceId, 'employees'),
      this.reader.entityData(sourceId, 'order_states'),
      this.reader.entityData(sourceId, 'order_kinds'),
      this.reader.entityData(sourceId, 'delivery_services'),
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
    const names = (rows: Map<string, Record<string, unknown>>) =>
      new Map([...rows].flatMap(([key, data]) => { const name = description(data); return name ? [[key, name] as const] : []; }));
    return {
      units: new Map([...units].map(([key, data]) => [key, { code: typeof data.Code === 'string' ? data.Code.trim() : null, name: description(data) }])),
      itemNames: new Map([...items].flatMap(([key, data]) => { const name = description(data); return name ? [[key, name] as const] : []; })),
      counterpartyNames: names(counterparties),
      userNames: names(users),
      employeeNames: names(employees),
      orderStateNames: names(orderStates),
      orderKindNames: names(orderKinds),
      deliveryServiceNames: names(deliveryServices),
      suppliers: group(suppliers.rows),
      sheetMaterials: group(sheets.rows),
      films: group(films.rows),
      currencies: new Map(currencies.rows.map((row) => [row.key, row.iso_code])),
      timeZone: source.rows[0]?.time_zone ?? 'Asia/Almaty',
    };
  }

  /**
   * Без блокировок: документы источника этих видов по ключу 1С — отпечаток, незавершённый конфликт и снятие с вида
   * (отбор документов прохода, план 2026-10-02 §3.6 R2-2; устаревание догонит следующий проход).
   */
  async storedState(sourceId: number, docKinds: readonly OnecDocKind[]): Promise<StoredState> {
    const { rows } = await this.database.query<{ ref: string; kind: OnecDocKind; observed: string | null; blocking: boolean; left_kind_to: OnecDocKind | null }>(
      `SELECT lower(d.onec_ref_key::text) AS ref, d.doc_kind AS kind, d.observed_fingerprint AS observed,
              (d.load_conflict ? 'proposedAmount' OR EXISTS (SELECT 1 FROM onec_document_lines l
                 WHERE l.onec_document_id = d.onec_document_id AND l.load_conflict_code IS NOT NULL)) AS blocking,
              d.load_conflict->>'kindChangedTo' AS left_kind_to
         FROM onec_documents d WHERE d.source_id = $1 AND d.doc_kind = ANY($2::text[])`,
      [sourceId, docKinds],
    );
    const state: StoredState = new Map();
    for (const row of rows) {
      state.set(row.ref, [...(state.get(row.ref) ?? []), { kind: row.kind, observed: row.observed, blocking: row.blocking, leftKindTo: row.left_kind_to }]);
    }
    return state;
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
      if (kind.ok && !ctx.enabledKinds.has(kind.docKind)) {
        // Целевой вид выключен (§3.6): документы прежнего вида всё равно снимаются с вида / удаляются, новый не создаётся.
        const other = await this.handleOtherKinds(tx, { ...ctx, docKind: kind.docKind }, kind.refKey);
        if (other.refused) return other.refused;
        return other.affected.length > 0
          ? { status: 'changed', conflicts: other.conflicts, removed: other.affected }
          : { status: 'skipped', conflicts: 0 };
      }
      // Смена вида в 1С (продажа ↔ возврат поставщику, оплата ↔ возврат покупателю): документ прежнего вида удаляется или,
      // если на него ссылаются потребители, снимается с вида (§3.6). Вид и ключ определены достоверно — прежний вид
      // закрывается до разбора реквизитов: ошибка данных нового документа (например, неизвестная валюта) не оставляет
      // прежнюю оплату распределяемой (code review R1-3); транзакция фиксируется и при invalid.
      const other = kind.ok
        ? await this.handleOtherKinds(tx, { ...ctx, docKind: kind.docKind }, kind.refKey)
        : { refused: null, affected: [], conflicts: 0 };
      if (other.refused) return other.refused;
      const removed = other.affected.length > 0 ? { removed: other.affected } : {};
      const parsed = parseDocument(ctx.config, row.data);
      if (!parsed.ok) return { status: 'invalid', code: parsed.code, ...removed };
      const target = buildTarget(parsed, refs, row.missing);
      if (!target.ok) return { status: 'invalid', code: target.code, ...removed };
      const docCtx: DocContext = { ...ctx, docKind: parsed.header.docKind };
      const outcome = await this.loadCurrentKind(tx, docCtx, parsed.header.refKey, target);
      return outcome.status === 'invalid' ? { ...outcome, ...removed }
        : { ...outcome, docKind: docCtx.docKind, conflicts: outcome.conflicts + other.conflicts, ...removed };
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
           operation_kind, doc_at, warehouse_ref_key, destination_warehouse_ref_key, normalizer_version,
           author_ref_key, author_name, responsible_ref_key, responsible_name, onec_order_ref_key, basis_ref_key, basis_type)
         VALUES ($1, $2, $3::uuid, $4, $5::date, $6, $7, $8::uuid, $9, $10, $11::numeric, $12, $13, now(),
           CASE WHEN $14 THEN now() END, $15, $16, 0,
           $17, ($18::timestamp AT TIME ZONE $19::text), $20::uuid, $21::uuid, $22,
           $23::uuid, $24, $25::uuid, $26, $27::uuid, $28::uuid, $29)
         ON CONFLICT (source_id, doc_kind, onec_ref_key) DO NOTHING
         RETURNING onec_document_id::text AS id`,
        [ctx.sourceId, ctx.docKind, refKey, ...this.headerValues(target.header), target.fingerprint,
          ...this.v2HeaderValues(target.header), NORMALIZER_VERSION, ...this.v3HeaderValues(target.header)],
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

  /** Поля, добавленные в v3: авторы, заказ покупателя шапки, основание. */
  private v3HeaderValues(header: TargetHeader): unknown[] {
    return [header.authorRefKey, header.authorName, header.responsibleRefKey, header.responsibleName, header.onecOrderRefKey,
      header.basisRefKey, header.basisType];
  }

  /**
   * Документы того же `Ref_Key` другого вида этой сущности (смена `ВидОперации` в 1С, §3.6): без ссылок потребителей —
   * удаляются физически вместе со строками (аудит, событие); со ссылками (любыми, включая исторические) — снимаются с
   * вида: значения не меняются, все строки — удаление через guard-ы потребителей, шапка — пропажа + `kindChangedTo`.
   * Уже снятый документ без незавершённых конфликтов строк не трогается (повтор прохода идемпотентен).
   */
  private async handleOtherKinds(
    tx: DatabaseClient,
    ctx: DocContext,
    refKey: string,
  ): Promise<{ refused: DocumentOutcome | null; affected: Array<{ documentId: number; docKind: OnecDocKind }>; conflicts: number }> {
    const affected: Array<{ documentId: number; docKind: OnecDocKind }> = [];
    let conflictCount = 0;
    const others = entityDocKinds(ctx.config).filter((kind) => kind !== ctx.docKind);
    if (others.length === 0) return { refused: null, affected, conflicts: 0 };
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
      let referenced = false;
      for (const consumer of this.consumers.forKind(header.doc_kind)) {
        if ((await consumer.referencedLineIds(tx, ids)).size > 0) { referenced = true; break; }
      }
      const oldCtx: DocContext = { ...ctx, docKind: header.doc_kind };
      if (referenced) {
        if (header.load_conflict?.kindChangedTo === ctx.docKind && !lines.some((line) => line.load_conflict_code !== null)) continue;
        const withdrawn = await this.withdrawKind(tx, oldCtx, header, lines, refKey, ctx.docKind);
        // Only a committed revision counts: a still-blocked withdrawal re-checked by a later pass is not a change.
        if (withdrawn.changed) {
          conflictCount += withdrawn.conflicts;
          affected.push({ documentId, docKind: header.doc_kind });
        }
        continue;
      }
      const beforeState = await this.readState(tx, documentId);
      await tx.query('DELETE FROM onec_customer_orders WHERE onec_document_id = $1', [documentId]);
      await tx.query('DELETE FROM onec_document_lines WHERE onec_document_id = $1', [documentId]);
      await tx.query('DELETE FROM onec_documents WHERE onec_document_id = $1', [documentId]);
      const revision = Number(header.applied_revision) + 1;
      const auditId = await auditService.record(tx, {
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
        before: { ...this.headerSnapshot(header, lines.length, beforeState.order), lines: lines.map(lineAudit) },
        after: null,
        diff: { docKind: { from: header.doc_kind, to: ctx.docKind } },
        metadata: {
          sourceId: ctx.sourceId, docKind: header.doc_kind, newDocKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision,
          runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, reason: 'kind_changed', onecRefKey: refKey,
        },
      });
      await this.insertAuditRefs(tx, auditId, ctx.sourceId, auditRefsOfState(beforeState, refKey), []);
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('onec.document_changed', 'onec_document', $1, $2::jsonb, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [String(documentId), JSON.stringify({
          eventId: randomUUID(), eventType: 'onec.document_changed', documentId, docKind: header.doc_kind, sourceId: ctx.sourceId,
          revision, runId: ctx.runId, requestId: ctx.requestId, correlationId: ctx.correlationId, occurredAt: new Date().toISOString(),
          removed: true, reason: 'kind_changed', newDocKind: ctx.docKind, linesChanged: ids,
          ...eventContext(oldCtx, 'removed', refKey, beforeState, null),
        }), `onec_document:${documentId}:${revision}`],
      );
      await this.alerts.resolve(tx, `${CONFLICT_ALERT_KIND}:${documentId}`);
      affected.push({ documentId, docKind: header.doc_kind });
    }
    return { refused: null, affected, conflicts: conflictCount };
  }

  /**
   * Снятие документа с вида (§3.6, R3-1) — не обычная пропажа: значения шапки и строк не меняются; каждая не снятая
   * строка (и строка с незавершённым конфликтом) подаётся потребителям как удаление: с активным распределением —
   * конфликт, иначе — `removed_in_onec_at`; шапка — пропажа + `kindChangedTo`, отпечаток-метка. Возвращает, изменилось
   * ли применённое состояние (новая ревизия), и число конфликтов.
   */
  private async withdrawKind(
    tx: DatabaseClient, ctx: DocContext, header: HeaderRow, lines: LineRow[], refKey: string, newKind: OnecDocKind,
  ): Promise<{ changed: boolean; conflicts: number }> {
    const documentId = Number(header.onec_document_id);
    const changes: DocumentLineChange[] = lines
      .filter((line) => line.removed_in_onec_at === null || line.load_conflict_code !== null)
      .map((line) => ({ lineId: Number(line.onec_document_line_id), lineNo: line.line_no, kind: 'remove' as const, before: stateOfRow(line), after: null }));
    const view: LoadedDocumentView = {
      documentId, sourceId: ctx.sourceId, docKind: header.doc_kind, onecRefKey: refKey, docDate: header.doc_date,
      posted: header.posted, deletedInOnec: header.deleted_in_onec, supplierId: header.supplier_id === null ? null : Number(header.supplier_id),
      counterpartyRefKey: header.counterparty_ref_key, counterpartyName: header.counterparty_name, amount: header.amount,
      currency: header.currency, previous: { currency: header.currency, amount: header.amount },
    };
    const conflicts = new Map<number, LineConflictCode>();
    const lineCodes = new Map<number, LineConflictCode[]>();
    for (const consumer of this.consumers.forKind(header.doc_kind)) {
      for (const conflict of await consumer.guardLineChanges(tx, view, changes)) {
        if (!conflicts.has(conflict.lineNo)) conflicts.set(conflict.lineNo, conflict.code);
        const codes = lineCodes.get(conflict.lineNo) ?? [];
        if (!codes.includes(conflict.code)) lineCodes.set(conflict.lineNo, [...codes, conflict.code]);
      }
    }
    for (const change of changes) {
      await tx.query(
        'UPDATE onec_document_lines SET removed_in_onec_at = COALESCE(removed_in_onec_at, now()), load_conflict_code = $2 WHERE onec_document_line_id = $1',
        [change.lineId, conflicts.get(change.lineNo) ?? null],
      );
    }
    const conflictDetails = changes.filter((change) => conflicts.has(change.lineNo)).map((change) => ({
      lineNo: change.lineNo, lineId: change.lineId, code: conflicts.get(change.lineNo)!, codes: lineCodes.get(change.lineNo)!,
      before: change.before, after: null,
    }));
    await tx.query(
      `UPDATE onec_documents SET missing_in_source_at = COALESCE(missing_in_source_at, now()), load_conflict = $2::jsonb,
         observed_fingerprint = $3, updated_at = now()
       WHERE onec_document_id = $1`,
      [documentId, JSON.stringify({ lines: conflictDetails, missingInSource: true, kindChangedTo: newKind, proposedAmount: null }),
        `kind_changed:${newKind}`],
    );
    const state = await this.readState(tx, documentId);
    const changed = await this.commitRevision(tx, ctx, refKey, state, header, lines, {
      created: false,
      conflicts: conflictDetails.map((detail) => ({ lineNo: detail.lineNo, code: detail.code })),
      linesChanged: changes.map((change) => change.lineId!).sort((a, b) => a - b),
      action: 'kind_changed',
    }, state.order);
    return { changed, conflicts: conflictDetails.length };
  }

  private headerValues(header: TargetHeader): unknown[] {
    return [header.number, header.docDate, header.posted, header.deletedInOnec, header.counterpartyRefKey, header.counterpartyName,
      header.supplierId, header.amount, header.currency, header.comment, header.missingInSource, header.mappingIssue];
  }

  private async insertLine(tx: DatabaseClient, documentId: number, line: TargetLine): Promise<number> {
    return Number((await tx.query<{ id: string }>(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_ref_key, nomenclature_name, quantity, unit_name,
         unit_code, price, amount, is_document_total, sheet_material_type_id, film_id, onec_order_ref_key, mapping_issue,
         warehouse_ref_key, is_stock_item, unit_is_package, line_section, settlement_doc_ref_key, settlement_doc_type, is_advance,
         content, line_shipment_date)
       VALUES ($1, $2, $3::uuid, $4, $5::numeric, $6, $7, $8::numeric, $9::numeric, $10, $11, $12, $13::uuid, $14, $15::uuid, $16, $17,
         $18, $19::uuid, $20, $21, $22, $23::date)
       RETURNING onec_document_line_id::text AS id`,
      [documentId, line.lineNo, line.nomenclatureRefKey, line.nomenclatureName, line.quantity, line.unitName, line.unitCode,
        line.price, line.amount, line.isDocumentTotal, line.sheetMaterialTypeId, line.filmId, line.onecOrderRefKey, line.mappingIssue,
        line.warehouseRefKey, line.isStockItem, line.unitIsPackage, ...this.v3LineValues(line)],
    )).rows[0].id);
  }

  /** Поля строки, добавленные в v3 (план 2026-10-02 §3.3). */
  private v3LineValues(line: TargetLine): unknown[] {
    return [line.section, line.settlementDocRefKey, line.settlementDocType, line.isAdvance, line.content, line.lineShipmentDate];
  }

  /** Реквизиты заказа покупателя (onec_customer_orders): upsert в транзакции документа; не заказ — строки нет. */
  private async writeOrder(tx: DatabaseClient, documentId: number, order: TargetCustomerOrder | null, timeZone: string): Promise<void> {
    if (order === null) {
      await tx.query('DELETE FROM onec_customer_orders WHERE onec_document_id = $1', [documentId]);
      return;
    }
    await tx.query(
      `INSERT INTO onec_customer_orders AS o (onec_document_id, state_ref_key, state_name, order_kind_ref_key, order_kind_name, payment_status,
         production_status, completion_variant, delivery_method, shipment_date, delivery_address, delivery_service_ref_key,
         delivery_service_name, expected_delivery_date, sales_unit_ref_key, workshop_ref_key, contract_ref_key, onec_changed_at, updated_at)
       VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10::date, $11, $12::uuid, $13, $14::date, $15::uuid, $16::uuid, $17::uuid,
         ($18::timestamp AT TIME ZONE $19::text), now())
       ON CONFLICT (onec_document_id) DO UPDATE SET state_ref_key = EXCLUDED.state_ref_key, state_name = EXCLUDED.state_name,
         order_kind_ref_key = EXCLUDED.order_kind_ref_key, order_kind_name = EXCLUDED.order_kind_name,
         payment_status = EXCLUDED.payment_status, production_status = EXCLUDED.production_status,
         completion_variant = EXCLUDED.completion_variant, delivery_method = EXCLUDED.delivery_method,
         shipment_date = EXCLUDED.shipment_date, delivery_address = EXCLUDED.delivery_address,
         delivery_service_ref_key = EXCLUDED.delivery_service_ref_key, delivery_service_name = EXCLUDED.delivery_service_name,
         expected_delivery_date = EXCLUDED.expected_delivery_date, sales_unit_ref_key = EXCLUDED.sales_unit_ref_key,
         workshop_ref_key = EXCLUDED.workshop_ref_key, contract_ref_key = EXCLUDED.contract_ref_key,
         onec_changed_at = EXCLUDED.onec_changed_at, updated_at = now()`,
      [documentId, order.stateRefKey, order.stateName, order.orderKindRefKey, order.orderKindName, order.paymentStatus,
        order.productionStatus, order.completionVariant, order.deliveryMethod, order.shipmentDate, order.deliveryAddress,
        order.deliveryServiceRefKey, order.deliveryServiceName, order.expectedDeliveryDate, order.salesUnitRefKey, order.workshopRefKey,
        order.contractRefKey, order.onecChangedAtLocal, timeZone],
    );
  }

  /** Ссылки 1С записи аудита (§10, R1-3): до и после изменения, включая неразрешённые. */
  private async insertAuditRefs(tx: DatabaseClient, auditId: string, sourceId: number, before: AuditOnecRef[], after: AuditOnecRef[]): Promise<void> {
    const rows = [...before.map((ref) => ({ ...ref, state: 'before' })), ...after.map((ref) => ({ ...ref, state: 'after' }))];
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO onec_document_audit_refs (audit_id, source_id, ref_role, onec_ref_key, onec_type, state)
       SELECT $1::uuid, $2, r.role, r.ref::uuid, r.type, r.state
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS r(role, ref, type, state)
       ON CONFLICT DO NOTHING`,
      [auditId, sourceId, rows.map((row) => row.role), rows.map((row) => row.refKey), rows.map((row) => row.type), rows.map((row) => row.state)],
    );
  }

  private async finishNew(tx: DatabaseClient, ctx: DocContext, documentId: number, refKey: string, header: TargetHeader, lines: TargetLine[]): Promise<DocumentOutcome> {
    for (const line of lines) await this.insertLine(tx, documentId, line);
    await this.writeOrder(tx, documentId, header.customerOrder, header.timeZone);
    const state = await this.readState(tx, documentId);
    await this.commitRevision(tx, ctx, refKey, state, null, [], {
      created: true, conflicts: [], linesChanged: state.lines.map((l) => Number(l.onec_document_line_id)),
    }, null);
    return { status: 'created', conflicts: 0, documentId };
  }

  private async readOrder(tx: DatabaseClient, documentId: number): Promise<OrderRow | null> {
    return (await tx.query<OrderRow>(`${ORDER_SELECT} WHERE onec_document_id = $1`, [documentId])).rows[0] ?? null;
  }

  private async readState(tx: DatabaseClient, documentId: number): Promise<DocumentState> {
    const header = (await tx.query<HeaderRow>(`${HEADER_SELECT} WHERE onec_document_id = $1`, [documentId])).rows[0];
    const lines = (await tx.query<LineRow>(`${LINE_SELECT} WHERE onec_document_id = $1 ORDER BY line_no, onec_document_lines.onec_document_line_id`, [documentId])).rows;
    return { header, lines, order: await this.readOrder(tx, documentId) };
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
    // Снятый с вида документ (§3.6) никогда не «без изменений»: его отпечаток — метка, но проверка явная.
    const leftKind = (header.load_conflict?.kindChangedTo ?? null) !== null;
    if (header.observed_fingerprint === fingerprint && !blocking && !leftKind) return { status: 'unchanged', conflicts: 0 };
    const beforeOrder = await this.readOrder(tx, documentId);

    // 1. Изменения строк относительно целевого состояния.
    const current = new Map(lines.map((line) => [line.line_no, line]));
    const wanted = new Map(targetLines.map((line) => [line.lineNo, line]));

    // Переход правил на текущую версию (v1 → v2, план расхода §3.2 R2-2; v2 → v3, план 2026-10-02 §3.5): применённое
    // состояние совпадает с целевым по всем полям сохранённой версии, отличаются только поля более новых версий —
    // техническое обновление: оба отпечатка, без ревизии, outbox и события; одна запись аудита перехода.
    if (header.normalizer_version !== NORMALIZER_VERSION && !blocking && !leftKind
      && (await this.sameAppliedState(tx, header, lines, beforeOrder, target, targetLines))) {
      await tx.query(
        `UPDATE onec_documents SET operation_kind = $2, doc_at = ($3::timestamp AT TIME ZONE $4::text), warehouse_ref_key = $5::uuid,
           destination_warehouse_ref_key = $6::uuid, normalizer_version = $7, observed_fingerprint = $8,
           author_ref_key = $9::uuid, author_name = $10, responsible_ref_key = $11::uuid, responsible_name = $12,
           onec_order_ref_key = $13::uuid, basis_ref_key = $14::uuid, basis_type = $15
         WHERE onec_document_id = $1`,
        [documentId, ...this.v2HeaderValues(target), NORMALIZER_VERSION, fingerprint, ...this.v3HeaderValues(target)],
      );
      for (const line of targetLines) {
        await tx.query(
          `UPDATE onec_document_lines SET warehouse_ref_key = $2::uuid, is_stock_item = $3, unit_is_package = $4, onec_order_ref_key = $5::uuid,
             line_section = $6, settlement_doc_ref_key = $7::uuid, settlement_doc_type = $8, is_advance = $9, content = $10,
             line_shipment_date = $11::date
           WHERE onec_document_line_id = $1`,
          [current.get(line.lineNo)!.onec_document_line_id, line.warehouseRefKey, line.isStockItem, line.unitIsPackage, line.onecOrderRefKey,
            ...this.v3LineValues(line)],
        );
      }
      await this.writeOrder(tx, documentId, target.customerOrder, target.timeZone);
      const upgraded = await this.readState(tx, documentId);
      await tx.query('UPDATE onec_documents SET applied_fingerprint = $2 WHERE onec_document_id = $1', [documentId, this.appliedFingerprint(upgraded)]);
      // Аудит перехода — в транзакции документа (code review R1-1): сбой после commit не теряет запись; ревизии и outbox нет.
      const auditId = await auditService.record(tx, {
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
          warehouseRefKey: upgraded.header.warehouse_ref_key, authorRefKey: upgraded.header.author_ref_key, authorName: upgraded.header.author_name,
          responsibleRefKey: upgraded.header.responsible_ref_key, responsibleName: upgraded.header.responsible_name,
          onecOrderRefKey: upgraded.header.onec_order_ref_key, basisRefKey: upgraded.header.basis_ref_key, basisType: upgraded.header.basis_type,
          customerOrder: orderAudit(upgraded.order),
          lines: upgraded.lines.map((line) => ({
            lineNo: line.line_no, warehouseRefKey: line.warehouse_ref_key, isStockItem: line.is_stock_item, unitIsPackage: line.unit_is_package,
            section: line.line_section, onecOrderRefKey: line.onec_order_ref_key, settlementDocRefKey: line.settlement_doc_ref_key,
            settlementDocType: line.settlement_doc_type, isAdvance: line.is_advance, content: line.content, lineShipmentDate: line.line_shipment_date,
          })),
        },
        diff: { normalizerVersion: { from: header.normalizer_version, to: NORMALIZER_VERSION } },
        metadata: {
          sourceId: ctx.sourceId, docKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision: Number(header.applied_revision),
          runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, normalizerVersion: NORMALIZER_VERSION,
        },
      });
      await this.insertAuditRefs(tx, auditId, ctx.sourceId, auditRefsOfState({ header, lines }, refKey), auditRefsOfState(upgraded, refKey));
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
      currency: target.currency, previous: { currency: header.currency, amount: header.amount },
    };
    const consumers = this.consumers.forKind(ctx.docKind);
    // Код строки для показа — первый по порядку потребителей; блокировки полей шапки — по ВСЕМ кодам (code review R1-1).
    const conflicts = new Map<number, LineConflictCode>();
    const allCodes = new Set<LineConflictCode>();
    const lineCodes = new Map<number, LineConflictCode[]>();
    for (const consumer of consumers) {
      for (const conflict of await consumer.guardLineChanges(tx, view, changes)) {
        if (!conflicts.has(conflict.lineNo)) conflicts.set(conflict.lineNo, conflict.code);
        allCodes.add(conflict.code);
        const codes = lineCodes.get(conflict.lineNo) ?? [];
        if (!codes.includes(conflict.code)) lineCodes.set(conflict.lineNo, [...codes, conflict.code]);
      }
    }
    const removedIds = changes.filter((change) => change.kind === 'remove').map((change) => change.lineId!);
    const referenced = new Set<number>();
    for (const consumer of consumers) for (const id of await consumer.referencedLineIds(tx, removedIds)) referenced.add(id);

    // 3. Шапка. Поле, ограничивающее существующие распределения (сумма оплаты), при конфликте не меняется (R3-1).
    // Валюта, в которой хранятся суммы распределений, при конфликте не меняется (как сумма оплаты); сумма — вместе с ней:
    // новая сумма в прежней валюте не применяется (code review R1-2). Оба предложения сохраняются.
    const currencyConflict = allCodes.has('CURRENCY_CHANGED');
    const amountConflict = allCodes.has('AMOUNT_BELOW_ALLOCATED') || currencyConflict;
    // Конфликт строки, которая сама не меняется (смена валюты шапки): строка остаётся, получает код конфликта.
    const unchangedConflicts = [...conflicts.entries()]
      .filter(([lineNo]) => !changes.some((change) => change.lineNo === lineNo) && current.has(lineNo))
      .map(([lineNo, code]) => ({ row: current.get(lineNo)!, code }));
    const conflictDetails = [
      ...changes.filter((change) => conflicts.has(change.lineNo)).map((change) => ({
        lineNo: change.lineNo, lineId: change.lineId, code: conflicts.get(change.lineNo)!, codes: lineCodes.get(change.lineNo)!,
        before: change.before, after: change.after,
      })),
      ...unchangedConflicts.map(({ row, code }) => ({
        lineNo: row.line_no, lineId: Number(row.onec_document_line_id), code, codes: lineCodes.get(row.line_no)!,
        before: stateOfRow(row), after: stateOfRow(row),
      })),
    ].sort((left, right) => left.lineNo - right.lineNo);
    const loadConflict = conflictDetails.length > 0 || target.missingInSource
      ? {
        lines: conflictDetails, missingInSource: target.missingInSource, proposedAmount: amountConflict ? target.amount : null,
        ...(currencyConflict ? { proposedCurrency: target.currency } : {}),
      }
      : null;
    await tx.query(
      `UPDATE onec_documents SET number = $2, doc_date = $3::date, posted = $4, deleted_in_onec = $5, counterparty_ref_key = $6::uuid,
         counterparty_name = $7, supplier_id = $8, amount = CASE WHEN $15 THEN amount ELSE $9::numeric END,
         currency = CASE WHEN $23 THEN currency ELSE $10 END, comment = $11,
         missing_in_source_at = CASE WHEN $12 THEN COALESCE(missing_in_source_at, now()) END, mapping_issue = $13,
         observed_fingerprint = $14, load_conflict = $16::jsonb, source_updated_at = now(), updated_at = now(),
         operation_kind = $17, doc_at = ($18::timestamp AT TIME ZONE $19::text), warehouse_ref_key = $20::uuid,
         destination_warehouse_ref_key = $21::uuid, normalizer_version = $22,
         author_ref_key = $24::uuid, author_name = $25, responsible_ref_key = $26::uuid, responsible_name = $27,
         onec_order_ref_key = $28::uuid, basis_ref_key = $29::uuid, basis_type = $30
       WHERE onec_document_id = $1`,
      [documentId, ...this.headerValues(target), fingerprint, amountConflict, loadConflict === null ? null : JSON.stringify(loadConflict),
        ...this.v2HeaderValues(target), NORMALIZER_VERSION, currencyConflict, ...this.v3HeaderValues(target)],
    );
    await this.writeOrder(tx, documentId, target.customerOrder, target.timeZone);

    // 4. Строки.
    for (const { row, code } of unchangedConflicts) {
      await tx.query('UPDATE onec_document_lines SET load_conflict_code = $2 WHERE onec_document_line_id = $1', [row.onec_document_line_id, code]);
    }
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
               warehouse_ref_key = $14::uuid, is_stock_item = $15, unit_is_package = $16, line_section = $17, settlement_doc_ref_key = $18::uuid,
               settlement_doc_type = $19, is_advance = $20, content = $21, line_shipment_date = $22::date
             WHERE onec_document_line_id = $1`,
            [change.lineId, line.nomenclatureRefKey, line.nomenclatureName, line.quantity, line.unitName, line.unitCode, line.price,
              line.amount, line.isDocumentTotal, line.sheetMaterialTypeId, line.filmId, line.onecOrderRefKey, line.mappingIssue,
              line.warehouseRefKey, line.isStockItem, line.unitIsPackage, ...this.v3LineValues(line)],
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
      // Строки, получившие код конфликта без собственных изменений, — тоже изменённые (code review R1-3).
      linesChanged: [...new Set([
        ...changes.filter((change) => change.lineId !== null).map((change) => change.lineId!), ...insertedIds,
        ...unchangedConflicts.map(({ row }) => Number(row.onec_document_line_id)),
      ])].sort((a, b) => a - b),
    }, beforeOrder);
    return { status: changed ? 'changed' : 'unchanged', conflicts: conflictDetails.length };
  }

  /**
   * Применённое состояние совпадает с целевым по всем полям версии правил, в которой оно записано (v1 — исходные поля;
   * v2 — ещё вид операции, момент, склады, признаки строк), без конфликтов, пропажи и удалённых строк. Поля более
   * новых версий не сравниваются — они и есть предмет технического перехода.
   */
  private async sameAppliedState(
    tx: DatabaseClient, header: HeaderRow, lines: LineRow[], order: OrderRow | null, target: TargetHeader, targetLines: TargetLine[],
  ): Promise<boolean> {
    if (header.load_conflict !== null || header.missing_in_source_at !== null || target.missingInSource) return false;
    // Реквизиты заказа появились только в v3: у документа прежней версии их быть не может.
    if (order !== null) return false;
    const sameHeader = header.number === target.number && header.doc_date === target.docDate && header.posted === target.posted
      && header.deleted_in_onec === target.deletedInOnec && header.counterparty_ref_key === target.counterpartyRefKey
      && header.counterparty_name === target.counterpartyName && num(header.supplier_id) === target.supplierId
      && sameNumber(header.amount, target.amount) && header.currency === target.currency && header.comment === target.comment
      && header.mapping_issue === target.mappingIssue;
    if (!sameHeader || lines.length !== targetLines.length) return false;
    const level: 1 | 2 = header.normalizer_version === PREVIOUS_NORMALIZER_VERSION ? 2 : 1;
    if (level === 2) {
      if (header.operation_kind !== target.operationKind || header.warehouse_ref_key !== target.warehouseRefKey
        || header.destination_warehouse_ref_key !== target.destinationWarehouseRefKey) return false;
      // Момент документа сравнивается в UTC тем же выражением, каким он записывается.
      const docAt = (await tx.query<{ at: string }>(
        `SELECT to_char(($1::timestamp AT TIME ZONE $2::text) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`,
        [target.docAtLocal, target.timeZone],
      )).rows[0].at;
      if (header.doc_at !== docAt) return false;
    } else if (header.normalizer_version !== null) {
      return false;
    }
    // Ссылку заказа v3 выводит по-новому только у расходных накладных (`Заказ` + `_Type`, §3.2); у остальных видов она
    // обязана совпасть — иначе это изменение данных, а не переход правил.
    const orderRefDerivationChanged = header.doc_kind === 'sales_shipment' || header.doc_kind === 'supplier_return';
    const byNo = new Map(lines.map((row) => [row.line_no, row]));
    return targetLines.every((line) => {
      const row = byNo.get(line.lineNo);
      return row !== undefined && row.removed_in_onec_at === null && row.load_conflict_code === null && lineMatches(row, line, level)
        && (orderRefDerivationChanged || row.onec_order_ref_key === line.onecOrderRefKey);
    });
  }

  /** Снимок шапки (и реквизитов заказа) для аудита. */
  private headerSnapshot(row: HeaderRow, lineCount: number | null, order: OrderRow | null) {
    return {
      docKind: row.doc_kind, operationKind: row.operation_kind, docAt: row.doc_at, warehouseRefKey: row.warehouse_ref_key,
      destinationWarehouseRefKey: row.destination_warehouse_ref_key,
      number: row.number, docDate: row.doc_date, posted: row.posted, deletedInOnec: row.deleted_in_onec, amount: row.amount,
      supplierId: row.supplier_id === null ? null : Number(row.supplier_id), missingInSource: row.missing_in_source_at !== null,
      mappingIssue: row.mapping_issue, currency: row.currency, comment: row.comment, counterpartyRefKey: row.counterparty_ref_key,
      counterpartyName: row.counterparty_name,
      authorRefKey: row.author_ref_key, authorName: row.author_name, responsibleRefKey: row.responsible_ref_key,
      responsibleName: row.responsible_name, onecOrderRefKey: row.onec_order_ref_key, basisRefKey: row.basis_ref_key, basisType: row.basis_type,
      customerOrder: orderAudit(order),
      // Полное состояние конфликта: строки до/после и предложенная 1С сумма (R2 code review).
      loadConflict: row.load_conflict, ...(lineCount === null ? {} : { lines: lineCount }),
    };
  }

  /** Отпечаток применённого состояния: шапка + строки + конфликты + реквизиты заказа. */
  private appliedFingerprint(state: DocumentState): string {
    const { header } = state;
    return createHash('sha256').update(JSON.stringify({
      header: [header.number, header.doc_date, header.posted, header.deleted_in_onec, header.counterparty_ref_key, header.counterparty_name,
        header.supplier_id, header.amount, header.currency, header.comment, header.missing_in_source_at !== null, header.mapping_issue,
        header.load_conflict, header.doc_kind, header.operation_kind, header.doc_at, header.warehouse_ref_key,
        header.destination_warehouse_ref_key, header.author_ref_key, header.author_name, header.responsible_ref_key, header.responsible_name,
        header.onec_order_ref_key, header.basis_ref_key, header.basis_type],
      lines: state.lines.map((line) => [line.onec_document_line_id, line.line_no, line.nomenclature_ref_key, line.nomenclature_name,
        line.quantity, line.unit_name, line.unit_code, line.price, line.amount, line.is_document_total, line.sheet_material_type_id,
        line.film_id, line.onec_order_ref_key, line.removed_in_onec_at !== null, line.load_conflict_code, line.mapping_issue,
        line.warehouse_ref_key, line.is_stock_item, line.unit_is_package, line.line_section, line.settlement_doc_ref_key,
        line.settlement_doc_type, line.is_advance, line.content, line.line_shipment_date]),
      order: orderAudit(state.order),
    })).digest('hex');
  }

  private async commitRevision(
    tx: DatabaseClient,
    ctx: DocContext,
    refKey: string,
    state: DocumentState,
    before: HeaderRow | null,
    beforeLines: LineRow[],
    info: { created: boolean; conflicts: Array<{ lineNo: number; code: LineConflictCode }>; linesChanged: number[]; action?: 'kind_changed' },
    beforeOrder: OrderRow | null,
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
    const event = info.created ? 'onec.document.loaded' : info.action !== 'kind_changed' && info.conflicts.length > 0 ? 'onec.document.conflict' : 'onec.document.changed';
    const action: EventAction = info.action ?? (info.created ? 'loaded' : info.conflicts.length > 0 ? 'conflict' : 'changed');
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
    const headerBefore = before === null ? null : this.headerSnapshot(before, null, beforeOrder);
    const headerAfter = this.headerSnapshot(header, state.lines.length, state.order);
    const headerDiff = headerBefore === null ? {} : Object.fromEntries(Object.entries(headerAfter)
      .filter(([key, value]) => key !== 'lines' && JSON.stringify((headerBefore as Record<string, unknown>)[key]) !== JSON.stringify(value))
      .map(([key, value]) => [key, { from: (headerBefore as Record<string, unknown>)[key], to: value }]));
    const auditId = await auditService.record(tx, {
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
      stageCode: info.action ?? (info.created ? 'created' : info.conflicts.length > 0 ? 'conflict' : 'changed'),
      before: headerBefore === null ? null : { ...headerBefore, lines: beforeLines.map(lineAudit) },
      after: { ...headerAfter, lines: state.lines.map(lineAudit), conflicts: info.conflicts },
      diff: { header: headerDiff, lines: lineDiff },
      metadata: {
        sourceId: ctx.sourceId, docKind: ctx.docKind, entityCode: ctx.entityCode, documentId, revision,
        runId: ctx.runId, correlationId: ctx.correlationId, commandSource: SOURCE, linesChanged: info.linesChanged,
        ...(info.action === 'kind_changed' ? { newDocKind: header.load_conflict?.kindChangedTo ?? null } : {}),
      },
    });
    const beforeState: DocumentState | null = before === null ? null : { header: before, lines: beforeLines, order: beforeOrder };
    await this.insertAuditRefs(tx, auditId, ctx.sourceId, auditRefsOfState(beforeState, refKey), auditRefsOfState(state, refKey));
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
      ...(info.action === 'kind_changed' ? { reason: 'kind_changed', newDocKind: header.load_conflict?.kindChangedTo ?? null } : {}),
      ...eventContext(ctx, action, refKey, beforeState, state),
    };
    // Общая бизнес-очередь (не onec_outbox_events — её relay знает только события транспорта 1С).
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('onec.document_changed', 'onec_document', $1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [String(documentId), JSON.stringify(payload), `onec_document:${documentId}:${revision}`],
    );
    const dedupeKey = `${CONFLICT_ALERT_KIND}:${documentId}`;
    if (info.conflicts.length > 0 || info.action === 'kind_changed') {
      await this.alerts.raise(tx, {
        kind: CONFLICT_ALERT_KIND, sourceId: ctx.sourceId, dedupeKey, severity: 'warning',
        details: {
          documentId, docKind: ctx.docKind, number: header.number, conflicts: info.conflicts,
          ...(info.action === 'kind_changed' ? { kindChangedTo: header.load_conflict?.kindChangedTo ?? null } : {}),
        },
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
      currency: header.currency, previous: before === null ? null : { currency: before.currency, amount: before.amount },
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
