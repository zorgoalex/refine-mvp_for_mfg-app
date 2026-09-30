import { createHash } from 'node:crypto';

// Нормализация документов 1С из копии ETL в общий слой onec_documents / onec_document_lines
// (план 2026-09-30-onec-documents-loader-plan.md, Р5–Р7, R1-4, R2-3). Только чистые функции:
// разбор строки копии и сборка целевого состояния документа из разобранных данных и справочных значений.

export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';

/** Версия правил нормализации: входит в отпечаток — смена правил переприменяет все документы. */
export const NORMALIZER_VERSION = 'onec-documents-v1';

export interface DocumentEntityConfig {
  docKind: OnecDocKind;
  /** Коллекция табличной части со строками товаров; null — оплата (одна строка-итог). */
  linesField: string | null;
  currencyField: string;
}

export const DOCUMENT_ENTITIES: Readonly<Record<string, DocumentEntityConfig>> = {
  doc_purchase_receipts: { docKind: 'purchase_receipt', linesField: 'Запасы', currencyField: 'ВалютаДокумента_Key' },
  doc_cash_outflows: { docKind: 'cash_outflow', linesField: null, currencyField: 'ВалютаДенежныхСредств_Key' },
  doc_bank_outflows: { docKind: 'bank_outflow', linesField: null, currencyField: 'ВалютаДенежныхСредств_Key' },
};

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

export interface ParsedHeader {
  refKey: string;
  number: string;
  docDate: string; // YYYY-MM-DD
  posted: boolean;
  deletedInOnec: boolean;
  counterpartyRefKey: string | null;
  currencyRefKey: string | null;
  amount: string | null; // NUMERIC(14,2) лексема
  comment: string | null;
}

export interface ParsedLine {
  lineNo: number;
  nomenclatureRefKey: string | null;
  quantity: string; // NUMERIC(14,3)
  unitRefKey: string | null;
  price: string | null;
  amount: string | null;
  onecOrderRefKey: string | null;
  isDocumentTotal: boolean;
}

export type ParseResult = { ok: true; header: ParsedHeader; lines: ParsedLine[] } | { ok: false; code: string };

const ref = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return GUID.test(key) && key !== ZERO_GUID ? key : null;
};

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

/** Разбор строки копии документа. Ошибка — документ не загружается (код в итоге прохода). */
export function parseDocument(config: DocumentEntityConfig, data: Record<string, unknown>): ParseResult {
  const refKey = ref(data.Ref_Key);
  if (!refKey) return { ok: false, code: 'INVALID_REF_KEY' };
  const number = text(data.Number);
  if (!number || number.length > 64) return { ok: false, code: 'INVALID_NUMBER' };
  const date = typeof data.Date === 'string' ? data.Date.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, code: 'INVALID_DATE' };
  const amount = decimalLexeme(data.СуммаДокумента, 2);
  if (amount !== null && Number(amount) < 0) return { ok: false, code: 'NEGATIVE_AMOUNT' };
  const header: ParsedHeader = {
    refKey,
    number,
    docDate: date,
    posted: data.Posted === true,
    deletedInOnec: data.DeletionMark === true,
    counterpartyRefKey: ref(data.Контрагент_Key),
    currencyRefKey: ref(data[config.currencyField]),
    amount,
    comment: text(data.Комментарий),
  };
  if (config.linesField === null) {
    // Оплата (§4.4 плана закупок): одна строка-итог с суммой документа, количество 0.
    return { ok: true, header, lines: [{
      lineNo: 1, nomenclatureRefKey: null, quantity: '0.000', unitRefKey: null, price: null,
      amount: amount ?? '0.00', onecOrderRefKey: null, isDocumentTotal: true,
    }] };
  }
  const raw = data[config.linesField];
  if (!Array.isArray(raw)) return { ok: false, code: 'INVALID_LINES' };
  const lines: ParsedLine[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, code: 'INVALID_LINES' };
    const row = item as Record<string, unknown>;
    const lineNo = Number(row.LineNumber);
    if (!Number.isInteger(lineNo) || lineNo < 1 || seen.has(lineNo)) return { ok: false, code: 'INVALID_LINE_NUMBER' };
    seen.add(lineNo);
    const quantity = decimalLexeme(row.Количество, 3);
    if (quantity === null || Number(quantity) < 0) return { ok: false, code: 'INVALID_QUANTITY' };
    const lineAmount = decimalLexeme(row.Всего, 2);
    if (lineAmount !== null && Number(lineAmount) < 0) return { ok: false, code: 'NEGATIVE_AMOUNT' };
    lines.push({
      lineNo,
      nomenclatureRefKey: ref(row.Номенклатура_Key),
      quantity,
      unitRefKey: ref(row.ЕдиницаИзмерения),
      price: decimalLexeme(row.Цена, 2),
      amount: lineAmount,
      onecOrderRefKey: ref(row.ЗаказПокупателя_Key),
      isDocumentTotal: false,
    });
  }
  lines.sort((left, right) => left.lineNo - right.lineNo);
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
}

export interface TargetHeader {
  number: string;
  docDate: string;
  posted: boolean;
  deletedInOnec: boolean;
  counterpartyRefKey: string | null;
  counterpartyName: string | null;
  supplierId: number | null;
  amount: string | null;
  currency: string;
  comment: string | null;
  missingInSource: boolean;
  mappingIssue: string | null;
}

export interface TargetLine {
  lineNo: number;
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
}

export type TargetResult = { ok: true; header: TargetHeader; lines: TargetLine[]; fingerprint: string } | { ok: false; code: string };

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
  const currency = header.currencyRefKey ? refs.currencies.get(header.currencyRefKey) : undefined;
  if (!currency) return { ok: false, code: 'UNKNOWN_CURRENCY' };
  const supplierCandidates = header.counterpartyRefKey ? refs.suppliers.get(header.counterpartyRefKey) ?? [] : [];
  const targetHeader: TargetHeader = {
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
  };
  const lines = parsed.lines.map((line): TargetLine => {
    const unit = line.unitRefKey ? refs.units.get(line.unitRefKey) : undefined;
    const sheets = line.nomenclatureRefKey ? refs.sheetMaterials.get(line.nomenclatureRefKey) ?? [] : [];
    const films = line.nomenclatureRefKey ? refs.films.get(line.nomenclatureRefKey) ?? [] : [];
    const candidates = sheets.length + films.length;
    return {
      lineNo: line.lineNo,
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
    };
  });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ v: NORMALIZER_VERSION, header: targetHeader, lines }))
    .digest('hex');
  return { ok: true, header: targetHeader, lines, fingerprint };
}
