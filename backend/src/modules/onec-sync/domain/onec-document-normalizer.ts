import { createHash } from 'node:crypto';

// Нормализация документов 1С из копии ETL в общий слой onec_documents / onec_document_lines
// (план 2026-09-30-onec-documents-loader-plan.md, Р5–Р7, R1-4, R2-3). Только чистые функции:
// разбор строки копии и сборка целевого состояния документа из разобранных данных и справочных значений.

export type OnecDocKind =
  | 'purchase_receipt' | 'cash_outflow' | 'bank_outflow'
  | 'sales_shipment' | 'supplier_return' | 'inventory_writeoff' | 'inventory_transfer'
  | 'customer_order' | 'cash_receipt' | 'bank_receipt' | 'cash_refund' | 'bank_refund';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';

/** Виды закупок (потребитель — модуль закупок) и виды расхода (проекция склада), план §3.3. */
export const PROCUREMENT_DOC_KINDS: readonly OnecDocKind[] = ['purchase_receipt', 'cash_outflow', 'bank_outflow'];
export const CONSUMPTION_DOC_KINDS: readonly OnecDocKind[] = ['sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer'];
/** Заказы покупателей, поступления от покупателей и возвраты покупателям (план 2026-10-02 §3.1): потребителей нет. */
export const CUSTOMER_DOC_KINDS: readonly OnecDocKind[] = ['customer_order', 'cash_receipt', 'bank_receipt', 'cash_refund', 'bank_refund'];
export const ALL_DOC_KINDS: readonly OnecDocKind[] = [...PROCUREMENT_DOC_KINDS, ...CONSUMPTION_DOC_KINDS, ...CUSTOMER_DOC_KINDS];
export const DEFAULT_DOC_KINDS = 'purchase_receipt,cash_outflow,bank_outflow';

/** Версия правил нормализации: входит в отпечаток — смена правил переприменяет все документы. */
export const NORMALIZER_VERSION = 'onec-documents-v3';
/** Версия, переход с которой — технический (план 2026-10-02 §3.5): v3 добавляет только новые поля. */
export const PREVIOUS_NORMALIZER_VERSION = 'onec-documents-v2';

export interface DocumentEntityConfig {
  /** Вид документа по `ВидОперации`; ключ '*' — единственный вид сущности (поле не читается). */
  kinds: Readonly<Record<string, OnecDocKind>>;
  /** Коллекция табличной части со строками товаров; null — оплата (одна строка-итог). */
  linesField: string | null;
  /** Валюта шапки; null — у документа нет валюты (списание, перемещение). */
  currencyField: string | null;
  /** Склад шапки. */
  headerWarehouseField: string | null;
  /** Склад строки (приоритетнее шапки). */
  lineWarehouseField: string | null;
  /** Склад-получатель (перемещение). */
  destinationWarehouseField: string | null;
  /** Признак складской позиции строки (`ТипНоменклатурыЗапас`); null — все строки складские. */
  stockFlagField: string | null;
  /** Виды, у которых строки — расшифровка платежа (`РасшифровкаПлатежа`), а не `linesField` (план 2026-10-02 §3.3). */
  paymentLinesKinds?: readonly OnecDocKind[];
  /** Вторая ТЧ товарного документа — работы (`Работы` заказа покупателя), нумерация 1 000 000 + LineNumber. */
  worksField?: string;
  /** Заказ покупателя шапки (`Заказ` + `Заказ_Type`). */
  headerOrderField?: string;
  /** Ответственный шапки (`Ответственный_Key`). */
  responsibleField?: string;
}

/**
 * Оплаты закупок — только операции закупок, явно (план 2026-10-02-onec-customer-documents-plan.md §3.1, шаг 0): любая
 * другая операция (в т.ч. возврат покупателю `Покупателю`) — `UNKNOWN_OPERATION_KIND`, а не оплата поставщику; иначе
 * возвраты, выгруженные агентом, стали бы распределяемыми оплатами закупок.
 */
const PAYMENT_OUTFLOW_KINDS = {
  cash: { Поставщику: 'cash_outflow', НаРасходы: 'cash_outflow', Прочее: 'cash_outflow', Покупателю: 'cash_refund' },
  bank: { Поставщику: 'bank_outflow', НаРасходы: 'bank_outflow', Прочее: 'bank_outflow', Покупателю: 'bank_refund' },
} as const satisfies Record<string, Readonly<Record<string, OnecDocKind>>>;

export const DOCUMENT_ENTITIES: Readonly<Record<string, DocumentEntityConfig>> = {
  doc_purchase_receipts: {
    kinds: { '*': 'purchase_receipt' }, linesField: 'Запасы', currencyField: 'ВалютаДокумента_Key',
    headerWarehouseField: 'СтруктурнаяЕдиница_Key', lineWarehouseField: 'СтруктурнаяЕдиница_Key', destinationWarehouseField: null, stockFlagField: null,
  },
  doc_cash_outflows: {
    kinds: PAYMENT_OUTFLOW_KINDS.cash, linesField: null, currencyField: 'ВалютаДенежныхСредств_Key',
    headerWarehouseField: null, lineWarehouseField: null, destinationWarehouseField: null, stockFlagField: null,
    paymentLinesKinds: ['cash_refund'],
  },
  doc_bank_outflows: {
    kinds: PAYMENT_OUTFLOW_KINDS.bank, linesField: null, currencyField: 'ВалютаДенежныхСредств_Key',
    headerWarehouseField: null, lineWarehouseField: null, destinationWarehouseField: null, stockFlagField: null,
    paymentLinesKinds: ['bank_refund'],
  },
  doc_sales_shipments: {
    kinds: { ПродажаПокупателю: 'sales_shipment', ВозвратПоставщику: 'supplier_return' }, linesField: 'Запасы', currencyField: 'ВалютаДокумента_Key',
    headerWarehouseField: 'СтруктурнаяЕдиница_Key', lineWarehouseField: 'СтруктурнаяЕдиница_Key', destinationWarehouseField: null,
    stockFlagField: 'ТипНоменклатурыЗапас', headerOrderField: 'Заказ', responsibleField: 'Ответственный_Key',
  },
  doc_customer_orders: {
    kinds: { ЗаказНаПродажу: 'customer_order' }, linesField: 'Запасы', worksField: 'Работы', currencyField: 'ВалютаДокумента_Key',
    headerWarehouseField: 'СтруктурнаяЕдиницаРезерв_Key', lineWarehouseField: 'СтруктурнаяЕдиницаРезерв_Key', destinationWarehouseField: null,
    stockFlagField: 'ТипНоменклатурыЗапас', responsibleField: 'Ответственный_Key',
  },
  doc_cash_receipts: {
    kinds: { ОтПокупателя: 'cash_receipt' }, linesField: null, currencyField: 'ВалютаДенежныхСредств_Key',
    headerWarehouseField: null, lineWarehouseField: null, destinationWarehouseField: null, stockFlagField: null,
    paymentLinesKinds: ['cash_receipt'],
  },
  doc_bank_receipts: {
    kinds: { ОтПокупателя: 'bank_receipt' }, linesField: null, currencyField: 'ВалютаДенежныхСредств_Key',
    headerWarehouseField: null, lineWarehouseField: null, destinationWarehouseField: null, stockFlagField: null,
    paymentLinesKinds: ['bank_receipt'],
  },
  doc_inventory_writeoffs: {
    kinds: { '*': 'inventory_writeoff' }, linesField: 'Запасы', currencyField: null,
    headerWarehouseField: 'СтруктурнаяЕдиница_Key', lineWarehouseField: null, destinationWarehouseField: null, stockFlagField: null,
  },
  doc_inventory_transfers: {
    kinds: { Перемещение: 'inventory_transfer' }, linesField: 'Запасы', currencyField: null,
    headerWarehouseField: 'СтруктурнаяЕдиница_Key', lineWarehouseField: null, destinationWarehouseField: 'СтруктурнаяЕдиницаПолучатель_Key',
    stockFlagField: null,
  },
};

/** Все виды, которые может дать сущность. */
export function entityDocKinds(config: DocumentEntityConfig): OnecDocKind[] {
  return [...new Set(Object.values(config.kinds))].sort();
}

/**
 * Действующие виды (план §3.3, R1-4): список `BACKEND_ONEC_DOCUMENTS_KINDS` ∩ разрешённые. Виды закупок — только при
 * включённом модуле закупок (их потребитель и guard-и); виды расхода и покупателей от закупок не зависят. Неизвестное
 * имя — ошибка.
 */
export function effectiveDocKinds(listed: string, procurementEnabled: boolean): Set<OnecDocKind> {
  const names = listed.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(ALL_DOC_KINDS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`Unknown 1C document kinds: ${unknown.join(', ')}`);
  return new Set((names as OnecDocKind[]).filter((kind) => procurementEnabled || !PROCUREMENT_DOC_KINDS.includes(kind)));
}

/** Код ОКЕИ единицы 1С → нормализованная единица ERP; остальные — NULL (единица неизвестна). */
export const OKEI_UNIT_CODES: Readonly<Record<string, OnecUnitCode>> = {
  '055': 'm2',
  '625': 'sheet',
  '006': 'lm',
  '018': 'lm',
  '796': 'pcs',
};

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CustomerOrderAttributes {
  stateRefKey: string | null;
  orderKindRefKey: string | null;
  paymentStatus: string | null;
  productionStatus: string | null;
  completionVariant: string | null;
  deliveryMethod: string | null;
  shipmentDate: string | null; // YYYY-MM-DD
  deliveryAddress: string | null;
  deliveryServiceRefKey: string | null;
  expectedDeliveryDate: string | null;
  salesUnitRefKey: string | null;
  workshopRefKey: string | null;
  contractRefKey: string | null;
  /** `ДатаИзменения` заказа — локальное время базы `YYYY-MM-DDTHH:MM:SS`. */
  onecChangedAtLocal: string | null;
}

export interface ParsedHeader {
  refKey: string;
  docKind: OnecDocKind;
  /** `ВидОперации` как есть (null — поле отсутствует). */
  operationKind: string | null;
  /** Локальное время базы 1С `YYYY-MM-DDTHH:MM:SS` (без смещения). */
  docAtLocal: string;
  warehouseRefKey: string | null;
  destinationWarehouseRefKey: string | null;
  number: string;
  docDate: string; // YYYY-MM-DD
  posted: boolean;
  deletedInOnec: boolean;
  counterpartyRefKey: string | null;
  currencyRefKey: string | null;
  amount: string | null; // NUMERIC(14,2) лексема
  comment: string | null;
  authorRefKey: string | null;
  responsibleRefKey: string | null;
  /** Заказ покупателя шапки (план 2026-10-02 §3.2). */
  onecOrderRefKey: string | null;
  basis: DocumentRef | null;
  customerOrder: CustomerOrderAttributes | null;
}

export type LineSection = 'goods' | 'works' | 'payment' | 'total';

export interface ParsedLine {
  lineNo: number;
  section: LineSection;
  nomenclatureRefKey: string | null;
  quantity: string; // NUMERIC(14,3)
  unitRefKey: string | null;
  price: string | null;
  amount: string | null;
  onecOrderRefKey: string | null;
  isDocumentTotal: boolean;
  warehouseRefKey: string | null;
  isStockItem: boolean;
  unitIsPackage: boolean;
  settlementDoc: DocumentRef | null;
  isAdvance: boolean;
  content: string | null;
  lineShipmentDate: string | null;
}

/** Ссылка на документ 1С: ключ (нижний регистр) и тип без префикса `StandardODATA.` (`Document_РасходнаяНакладная`). */
export interface DocumentRef {
  refKey: string;
  type: string;
}

export type ParseResult = { ok: true; header: ParsedHeader; lines: ParsedLine[] } | { ok: false; code: string };

const ref = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return GUID.test(key) && key !== ZERO_GUID ? key : null;
};

/** Работы заказа: `line_no = WORKS_LINE_BASE + LineNumber`; `LineNumber` любой ТЧ — 1 … MAX_SOURCE_LINE_NUMBER (§3.3). */
export const WORKS_LINE_BASE = 1_000_000;
export const MAX_SOURCE_LINE_NUMBER = 999_999;
const ODATA_PREFIX = 'StandardODATA.';
const CUSTOMER_ORDER_TYPE = 'StandardODATA.Document_ЗаказПокупателя';

/** Ссылка составного поля (`<поле>` + `<поле>_Type`) — только на документ (`Document_*`); иначе null. */
function documentRef(row: Record<string, unknown>, field: string): DocumentRef | null {
  const type = row[`${field}_Type`];
  if (typeof type !== 'string' || !type.startsWith(`${ODATA_PREFIX}Document_`)) return null;
  const key = ref(row[field]);
  return key ? { refKey: key, type: type.slice(ODATA_PREFIX.length) } : null;
}

/**
 * Заказ покупателя строки/шапки (план 2026-10-02 §3.2): пара `Заказ` + `Заказ_Type` = `Document_ЗаказПокупателя`;
 * запасной вариант — `ЗаказПокупателя_Key` (в выгрузке пуст). Заказ поставщику (приходы) — null.
 */
function customerOrderRef(row: Record<string, unknown>, field = 'Заказ'): string | null {
  if (row[`${field}_Type`] === CUSTOMER_ORDER_TYPE) {
    const key = ref(row[field]);
    if (key) return key;
  }
  return ref(row.ЗаказПокупателя_Key);
}

/** Дата 1С `YYYY-MM-DD…`; пустая дата 1С (`0001-01-01`) — null. */
function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0001-') ? date : null;
}

function localDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = value.slice(0, 19);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(at) && !at.startsWith('0001-') ? at : null;
}

/**
 * Число 1С → лексема с фиксированной точностью, округление половины вверх по цифрам (без двоичной арифметики:
 * 1.005 → 1.01). null — не число.
 */
export function decimalLexeme(value: unknown, scale: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  let match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) {
    const number = Number(raw);
    if (!raw || !Number.isFinite(number)) return null;
    match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(number.toFixed(20).replace(/0+$/, '').replace(/\.$/, ''));
    if (!match) return null;
  }
  const negative = match[1] === '-';
  const digits = `${match[2]}${(match[3] ?? '').padEnd(scale + 1, '0')}`.slice(0, match[2].length + scale + 1);
  let scaled = BigInt(digits.slice(0, -1));
  if (Number(digits.slice(-1)) >= 5) scaled += 1n;
  const text = scaled.toString().padStart(scale + 1, '0');
  const lexeme = scale > 0 ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
  return negative && scaled !== 0n ? `-${lexeme}` : lexeme;
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Вид по `ВидОперации`: только собственные ключи карты (`constructor`, `toString` — неизвестная операция, code review step 0). */
function kindOf(config: DocumentEntityConfig, operationKind: string | null): OnecDocKind | undefined {
  if (Object.prototype.hasOwnProperty.call(config.kinds, '*')) return config.kinds['*'];
  return operationKind !== null && Object.prototype.hasOwnProperty.call(config.kinds, operationKind) ? config.kinds[operationKind] : undefined;
}

/**
 * Вид документа по данным копии без разбора остального (gate действующих видов — до валидации, code review R2):
 * `{ ok, docKind, refKey }` или код ошибки ключа/вида операции.
 */
export function documentKindOf(config: DocumentEntityConfig, data: Record<string, unknown>):
  { ok: true; docKind: OnecDocKind; refKey: string } | { ok: false; code: string } {
  const refKey = ref(data.Ref_Key);
  if (!refKey) return { ok: false, code: 'INVALID_REF_KEY' };
  const operationKind = text(data.ВидОперации);
  const docKind = kindOf(config, operationKind);
  return docKind ? { ok: true, docKind, refKey } : { ok: false, code: 'UNKNOWN_OPERATION_KIND' };
}

/** Одна строка-итог оплаты с суммой документа (§4.4 плана закупок; расшифровки нет). */
function totalLine(amount: string | null): ParsedLine {
  return {
    lineNo: 1, section: 'total', nomenclatureRefKey: null, quantity: '0.000', unitRefKey: null, price: null,
    amount: amount ?? '0.00', onecOrderRefKey: null, isDocumentTotal: true, warehouseRefKey: null, isStockItem: true,
    unitIsPackage: false, settlementDoc: null, isAdvance: false, content: null, lineShipmentDate: null,
  };
}

const sourceLineNumber = (row: Record<string, unknown>): number | null => {
  const lineNo = Number(row.LineNumber);
  return Number.isInteger(lineNo) && lineNo >= 1 && lineNo <= MAX_SOURCE_LINE_NUMBER ? lineNo : null;
};

/** Строки расшифровки платежа (поступления, возвраты): сумма платежа, заказ, документ расчётов, аванс. */
function paymentLines(raw: unknown, amount: string | null): ParsedLine[] | { code: string } {
  if (raw === undefined || raw === null) return [totalLine(amount)];
  if (!Array.isArray(raw)) return { code: 'INVALID_LINES' };
  if (raw.length === 0) return [totalLine(amount)];
  const lines: ParsedLine[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { code: 'INVALID_LINES' };
    const row = item as Record<string, unknown>;
    const lineNo = sourceLineNumber(row);
    if (lineNo === null || seen.has(lineNo)) return { code: 'INVALID_LINE_NUMBER' };
    seen.add(lineNo);
    const lineAmount = decimalLexeme(row.СуммаПлатежа, 2);
    if (lineAmount === null) return { code: 'INVALID_AMOUNT' };
    if (Number(lineAmount) < 0) return { code: 'NEGATIVE_AMOUNT' };
    lines.push({
      lineNo, section: 'payment', nomenclatureRefKey: null, quantity: '0.000', unitRefKey: null, price: null, amount: lineAmount,
      onecOrderRefKey: customerOrderRef(row), isDocumentTotal: false, warehouseRefKey: null, isStockItem: true, unitIsPackage: false,
      settlementDoc: documentRef(row, 'Документ'), isAdvance: row.ПризнакАванса === true, content: null, lineShipmentDate: null,
    });
  }
  return lines.sort((left, right) => left.lineNo - right.lineNo);
}

/** Товарные строки (`Запасы`) и работы (`Работы`, номер 1 000 000 + LineNumber). */
function goodsLines(config: DocumentEntityConfig, raw: unknown, section: 'goods' | 'works', headerWarehouse: string | null): ParsedLine[] | { code: string } {
  if (!Array.isArray(raw)) return { code: 'INVALID_LINES' };
  const lines: ParsedLine[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { code: 'INVALID_LINES' };
    const row = item as Record<string, unknown>;
    const sourceNo = sourceLineNumber(row);
    if (sourceNo === null || seen.has(sourceNo)) return { code: 'INVALID_LINE_NUMBER' };
    seen.add(sourceNo);
    const quantity = decimalLexeme(row.Количество, 3);
    if (quantity === null || Number(quantity) < 0) return { code: 'INVALID_QUANTITY' };
    const lineAmount = decimalLexeme(row.Всего, 2);
    if (lineAmount !== null && Number(lineAmount) < 0) return { code: 'NEGATIVE_AMOUNT' };
    // Номенклатура заказа покупателя — составное поле (`Номенклатура` + `_Type`), у остальных документов — `_Key`.
    const nomenclature = ref(row.Номенклатура_Key)
      ?? (typeof row.Номенклатура_Type === 'string' && row.Номенклатура_Type.endsWith('Catalog_Номенклатура') ? ref(row.Номенклатура) : null);
    lines.push({
      lineNo: section === 'works' ? WORKS_LINE_BASE + sourceNo : sourceNo,
      section,
      nomenclatureRefKey: nomenclature,
      quantity,
      unitRefKey: ref(row.ЕдиницаИзмерения),
      price: decimalLexeme(row.Цена, 2),
      amount: lineAmount,
      onecOrderRefKey: customerOrderRef(row),
      isDocumentTotal: false,
      // Склад строки; у перемещения склада в строке нет — склад-источник шапки.
      warehouseRefKey: (config.lineWarehouseField ? ref(row[config.lineWarehouseField]) : null) ?? headerWarehouse,
      // Услуги/работы (`ТипНоменклатурыЗапас = false`, ТЧ «Работы») — не складской расход.
      isStockItem: section === 'works' ? false : config.stockFlagField ? row[config.stockFlagField] !== false : true,
      // Единица не из классификатора — единица упаковки: в OData она `UnavailableEntity_…` (справочник
      // `Catalog_ЕдиницыИзмерения` не опубликован), коэффициент неизвестен.
      unitIsPackage: typeof row.ЕдиницаИзмерения_Type === 'string' && !row.ЕдиницаИзмерения_Type.endsWith('Catalog_КлассификаторЕдиницИзмерения'),
      settlementDoc: null,
      isAdvance: false,
      content: text(row.Содержание),
      lineShipmentDate: dateOnly(row.ДатаОтгрузки),
    });
  }
  return lines;
}

function customerOrderAttributes(data: Record<string, unknown>): CustomerOrderAttributes {
  return {
    stateRefKey: ref(data.СостояниеЗаказа),
    orderKindRefKey: ref(data.ВидЗаказа),
    paymentStatus: text(data.Оплата),
    productionStatus: text(data.ПроизводственныйСтатус),
    completionVariant: text(data.ВариантЗавершения),
    deliveryMethod: text(data.СпособДоставки),
    shipmentDate: dateOnly(data.ДатаОтгрузки),
    deliveryAddress: text(data.АдресДоставки),
    deliveryServiceRefKey: ref(data.СлужбаДоставки_Key),
    expectedDeliveryDate: dateOnly(data.ОжидаемаяДатаВручения),
    salesUnitRefKey: ref(data.СтруктурнаяЕдиницаПродажи_Key),
    workshopRefKey: ref(data.Цех_Key),
    contractRefKey: ref(data.Договор_Key),
    onecChangedAtLocal: localDateTime(data.ДатаИзменения),
  };
}

/** Разбор строки копии документа. Ошибка — документ не загружается (код в итоге прохода). */
export function parseDocument(config: DocumentEntityConfig, data: Record<string, unknown>): ParseResult {
  const refKey = ref(data.Ref_Key);
  if (!refKey) return { ok: false, code: 'INVALID_REF_KEY' };
  const number = text(data.Number);
  if (!number || number.length > 64) return { ok: false, code: 'INVALID_NUMBER' };
  const operationKind = text(data.ВидОперации);
  const docKind = kindOf(config, operationKind);
  if (!docKind) return { ok: false, code: 'UNKNOWN_OPERATION_KIND' };
  const date = typeof data.Date === 'string' ? data.Date.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, code: 'INVALID_DATE' };
  const docAtLocal = typeof data.Date === 'string' ? data.Date.slice(0, 19) : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(docAtLocal)) return { ok: false, code: 'INVALID_DATE' };
  const headerWarehouse = config.headerWarehouseField ? ref(data[config.headerWarehouseField]) : null;
  const amount = decimalLexeme(data.СуммаДокумента, 2);
  if (amount !== null && Number(amount) < 0) return { ok: false, code: 'NEGATIVE_AMOUNT' };
  const header: ParsedHeader = {
    refKey,
    docKind,
    operationKind,
    docAtLocal,
    warehouseRefKey: headerWarehouse,
    destinationWarehouseRefKey: config.destinationWarehouseField ? ref(data[config.destinationWarehouseField]) : null,
    number,
    docDate: date,
    posted: data.Posted === true,
    deletedInOnec: data.DeletionMark === true,
    counterpartyRefKey: ref(data.Контрагент_Key),
    currencyRefKey: config.currencyField ? ref(data[config.currencyField]) : null,
    amount,
    comment: text(data.Комментарий),
    authorRefKey: ref(data.Автор_Key),
    responsibleRefKey: config.responsibleField ? ref(data[config.responsibleField]) : null,
    onecOrderRefKey: config.headerOrderField ? customerOrderRef(data, config.headerOrderField) : null,
    basis: documentRef(data, 'ДокументОснование'),
    customerOrder: docKind === 'customer_order' ? customerOrderAttributes(data) : null,
  };
  if (config.paymentLinesKinds?.includes(docKind)) {
    const lines = paymentLines(data.РасшифровкаПлатежа, amount);
    return Array.isArray(lines) ? { ok: true, header, lines } : { ok: false, code: lines.code };
  }
  // Оплата закупок (§4.4 плана закупок): одна строка-итог с суммой документа, количество 0.
  if (config.linesField === null) return { ok: true, header, lines: [totalLine(amount)] };
  const goods = goodsLines(config, data[config.linesField], 'goods', headerWarehouse);
  if (!Array.isArray(goods)) return { ok: false, code: goods.code };
  let works: ParsedLine[] = [];
  if (config.worksField && data[config.worksField] !== undefined && data[config.worksField] !== null) {
    const parsed = goodsLines(config, data[config.worksField], 'works', headerWarehouse);
    if (!Array.isArray(parsed)) return { ok: false, code: parsed.code };
    works = parsed;
  }
  const lines = [...goods, ...works].sort((left, right) => left.lineNo - right.lineNo);
  return { ok: true, header, lines };
}

/** Справочные значения для сборки целевого состояния (читаются загрузчиком). */
export interface ReferenceData {
  units: ReadonlyMap<string, { code: string | null; name: string | null }>;
  itemNames: ReadonlyMap<string, string>;
  counterpartyNames: ReadonlyMap<string, string>;
  /** ref_key_1c → id; несколько кандидатов — массив длиной > 1. */
  suppliers: ReadonlyMap<string, number[]>;
  sheetMaterials: ReadonlyMap<string, number[]>;
  films: ReadonlyMap<string, number[]>;
  currencies: ReadonlyMap<string, string>;
  /** Часовой пояс информационной базы источника (`onec_sources.time_zone`) — для `doc_at`. */
  timeZone: string;
  /** Имена справочников 1С (план 2026-10-02 §3.4): пользователи, сотрудники, состояния/виды заказов, службы доставки. */
  userNames: ReadonlyMap<string, string>;
  employeeNames: ReadonlyMap<string, string>;
  orderStateNames: ReadonlyMap<string, string>;
  orderKindNames: ReadonlyMap<string, string>;
  deliveryServiceNames: ReadonlyMap<string, string>;
}

/** Виды без валюты документа. */
const NO_CURRENCY_KINDS: ReadonlySet<OnecDocKind> = new Set(['inventory_writeoff', 'inventory_transfer']);

export interface TargetCustomerOrder extends CustomerOrderAttributes {
  stateName: string | null;
  orderKindName: string | null;
  deliveryServiceName: string | null;
}

export interface TargetHeader {
  docKind: OnecDocKind;
  operationKind: string | null;
  docAtLocal: string;
  timeZone: string;
  warehouseRefKey: string | null;
  destinationWarehouseRefKey: string | null;
  number: string;
  docDate: string;
  posted: boolean;
  deletedInOnec: boolean;
  counterpartyRefKey: string | null;
  counterpartyName: string | null;
  supplierId: number | null;
  amount: string | null;
  currency: string | null;
  comment: string | null;
  missingInSource: boolean;
  mappingIssue: string | null;
  authorRefKey: string | null;
  authorName: string | null;
  responsibleRefKey: string | null;
  responsibleName: string | null;
  onecOrderRefKey: string | null;
  basisRefKey: string | null;
  basisType: string | null;
  customerOrder: TargetCustomerOrder | null;
}

export interface TargetLine {
  lineNo: number;
  section: LineSection;
  nomenclatureRefKey: string | null;
  nomenclatureName: string | null;
  quantity: string;
  unitName: string | null;
  unitCode: OnecUnitCode | null;
  price: string | null;
  amount: string | null;
  isDocumentTotal: boolean;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  onecOrderRefKey: string | null;
  mappingIssue: string | null;
  warehouseRefKey: string | null;
  isStockItem: boolean;
  unitIsPackage: boolean;
  settlementDocRefKey: string | null;
  settlementDocType: string | null;
  isAdvance: boolean;
  content: string | null;
  lineShipmentDate: string | null;
}

export type TargetResult = { ok: true; header: TargetHeader; lines: TargetLine[]; fingerprint: string } | { ok: false; code: string };

const nameOf = (names: ReadonlyMap<string, string>, key: string | null): string | null => (key ? names.get(key) ?? null : null);

/**
 * Целевое состояние документа. Сопоставление материала — только при единственном кандидате среди листовых
 * материалов и канонических плёнок вместе (R2-3); поставщик — только при единственном `suppliers.ref_key_1c`.
 * Отпечаток — от целевого состояния и версии правил: он меняется при любом входе, влияющем на результат
 * (данные документа, пропажа из выгрузки, справочники, соответствие валют, сопоставление) — R1-4.
 */
export function buildTarget(
  parsed: { header: ParsedHeader; lines: ParsedLine[] },
  refs: ReferenceData,
  missingInSource: boolean,
): TargetResult {
  const { header } = parsed;
  const noCurrency = NO_CURRENCY_KINDS.has(header.docKind);
  const currency = noCurrency ? null : header.currencyRefKey ? refs.currencies.get(header.currencyRefKey) ?? null : null;
  if (!noCurrency && !currency) return { ok: false, code: 'UNKNOWN_CURRENCY' };
  const supplierCandidates = header.counterpartyRefKey ? refs.suppliers.get(header.counterpartyRefKey) ?? [] : [];
  const order = header.customerOrder;
  const targetHeader: TargetHeader = {
    docKind: header.docKind,
    operationKind: header.operationKind,
    docAtLocal: header.docAtLocal,
    timeZone: refs.timeZone,
    warehouseRefKey: header.warehouseRefKey,
    destinationWarehouseRefKey: header.destinationWarehouseRefKey,
    number: header.number,
    docDate: header.docDate,
    posted: header.posted,
    deletedInOnec: header.deletedInOnec,
    counterpartyRefKey: header.counterpartyRefKey,
    counterpartyName: header.counterpartyRefKey ? refs.counterpartyNames.get(header.counterpartyRefKey) ?? null : null,
    supplierId: supplierCandidates.length === 1 ? supplierCandidates[0] : null,
    amount: header.amount,
    currency,
    comment: header.comment,
    missingInSource,
    mappingIssue: supplierCandidates.length > 1 ? 'ambiguous_supplier' : null,
    authorRefKey: header.authorRefKey,
    authorName: nameOf(refs.userNames, header.authorRefKey),
    responsibleRefKey: header.responsibleRefKey,
    responsibleName: nameOf(refs.employeeNames, header.responsibleRefKey),
    onecOrderRefKey: header.onecOrderRefKey,
    basisRefKey: header.basis?.refKey ?? null,
    basisType: header.basis?.type ?? null,
    customerOrder: order === null ? null : {
      ...order,
      stateName: nameOf(refs.orderStateNames, order.stateRefKey),
      orderKindName: nameOf(refs.orderKindNames, order.orderKindRefKey),
      deliveryServiceName: nameOf(refs.deliveryServiceNames, order.deliveryServiceRefKey),
    },
  };
  const lines = parsed.lines.map((line): TargetLine => {
    const unit = line.unitRefKey ? refs.units.get(line.unitRefKey) : undefined;
    const sheets = line.nomenclatureRefKey ? refs.sheetMaterials.get(line.nomenclatureRefKey) ?? [] : [];
    const films = line.nomenclatureRefKey ? refs.films.get(line.nomenclatureRefKey) ?? [] : [];
    const candidates = sheets.length + films.length;
    return {
      lineNo: line.lineNo,
      section: line.section,
      nomenclatureRefKey: line.nomenclatureRefKey,
      nomenclatureName: line.nomenclatureRefKey ? refs.itemNames.get(line.nomenclatureRefKey) ?? null : null,
      quantity: line.quantity,
      unitName: unit?.name ?? null,
      unitCode: unit?.code ? OKEI_UNIT_CODES[unit.code] ?? null : null,
      price: line.price,
      amount: line.amount,
      isDocumentTotal: line.isDocumentTotal,
      sheetMaterialTypeId: candidates === 1 && sheets.length === 1 ? sheets[0] : null,
      filmId: candidates === 1 && films.length === 1 ? films[0] : null,
      onecOrderRefKey: line.onecOrderRefKey,
      mappingIssue: candidates > 1 ? 'ambiguous_material' : null,
      warehouseRefKey: line.warehouseRefKey,
      isStockItem: line.isStockItem,
      unitIsPackage: line.unitIsPackage,
      settlementDocRefKey: line.settlementDoc?.refKey ?? null,
      settlementDocType: line.settlementDoc?.type ?? null,
      isAdvance: line.isAdvance,
      content: line.content,
      lineShipmentDate: line.lineShipmentDate,
    };
  });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ v: NORMALIZER_VERSION, header: targetHeader, lines }))
    .digest('hex');
  return { ok: true, header: targetHeader, lines, fingerprint };
}

/** Ссылки 1С документа для аудита (план 2026-10-02 §10, R1-3): заказ (шапка и строки), документ зачёта, основание. */
export interface AuditOnecRef {
  role: 'customer_order' | 'settlement_doc' | 'basis';
  refKey: string;
  type: string | null;
}

export function auditRefsOf(
  header: { onecOrderRefKey: string | null; basisRefKey: string | null; basisType: string | null },
  lines: ReadonlyArray<{ onecOrderRefKey: string | null; settlementDocRefKey: string | null; settlementDocType: string | null }>,
): AuditOnecRef[] {
  const refs = new Map<string, AuditOnecRef>();
  const add = (role: AuditOnecRef['role'], refKey: string | null, type: string | null) => {
    if (refKey) refs.set(`${role}:${refKey}`, { role, refKey, type });
  };
  add('customer_order', header.onecOrderRefKey, 'Document_ЗаказПокупателя');
  add('basis', header.basisRefKey, header.basisType);
  for (const line of lines) {
    add('customer_order', line.onecOrderRefKey, 'Document_ЗаказПокупателя');
    add('settlement_doc', line.settlementDocRefKey, line.settlementDocType);
  }
  return [...refs.values()].sort((left, right) => `${left.role}:${left.refKey}`.localeCompare(`${right.role}:${right.refKey}`));
}
