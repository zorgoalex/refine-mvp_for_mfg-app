import { createHash } from 'node:crypto';

/**
 * Normalized Bitrix24 crm.item.productrow row. `unitPrice` is the final Bitrix
 * row price (`price`): per the official data-types reference it already
 * includes discounts and taxes, so it is imported unchanged and discount/tax
 * fields are provenance only.
 *
 * `quantity`/`unitPrice`/`lineTotal` are canonicalized to the exact PostgreSQL
 * text form (3 / 2 decimals) BEFORE any hash or fingerprint is computed, so a
 * remote "1"/"10000" never differs from the stored "1.000"/"10000.00".
 */
export interface Bitrix24ProductRow {
  rowId: string;
  productId: string;
  productName: string | null;
  sort: number | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  discountTypeId: number | null;
  discountRate: string | null;
  discountSum: string | null;
  taxRate: string | null;
  taxIncluded: 'Y' | 'N' | null;
  measureCode: number | null;
  measureName: string | null;
  raw: Record<string, unknown>;
  normalizedHash: string;
}

export type ProductRowFailure =
  | 'BITRIX24_PRODUCT_ROW_SHAPE'
  | 'BITRIX24_PRODUCT_ROW_CUSTOM'
  | 'BITRIX24_PRODUCT_ROW_PRECISION'
  | 'BITRIX24_PRODUCT_ROW_OVERFLOW';

export interface Bitrix24ProductRowInvalid {
  rowId: string | null;
  productId: string | null;
  code: ProductRowFailure;
}

// ERP order_catalog_lines numeric(12,3) quantity / numeric(12,2) price+amount.
// Extra TRAILING zeroes beyond the target scale are representable and
// accepted ("10.0000" -> "10.000"); genuinely nonzero excess precision
// ("1.0005") is rejected.
const QUANTITY_INT_DIGITS = 9;
const QUANTITY_SCALE = 3;
const PRICE_INT_DIGITS = 10;
const PRICE_SCALE = 2;
const LINE_TOTAL_MAX_CENTS = 999999999999n;
// Provenance-only fields keep arbitrary bounded decimals (Bitrix emits e.g.
// discountSum 9090.90909091); they never feed ERP monetary math.
const PROVENANCE_DECIMAL_RE = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/;
const MONEY_8DP_RE = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const normalized = String(BigInt(text));
  // IDs must fit a bigint across ordering/mapping SQL — bound at 15 digits.
  return normalized.length <= 15 ? normalized : null;
}

function positiveIdText(value: unknown): string | null {
  const text = idText(value);
  return text !== null && text !== '0' ? text : null;
}

function decimalText(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  return pattern.test(text) ? text : null;
}

function provenanceDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return decimalText(value, PROVENANCE_DECIMAL_RE);
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text ? text.slice(0, 500) : null;
}

/**
 * Parse a decimal into canonical zero-padded fixed-scale text, or null when
 * the value is not a plain decimal or carries nonzero digits beyond `scale`.
 */
function fitDecimal(
  value: unknown,
  intDigits: number,
  scale: number,
): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  if (whole.length > intDigits) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    if (!/^0*$/.test(fraction.slice(scale))) return null;
  }
  return `${whole}.${fraction.slice(0, scale).padEnd(scale, '0')}`;
}

function scaled(value: string, digits: number): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents =
    BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
  return negative ? -cents : cents;
}

/** quantity(3dp) * unitPrice(2dp) -> amount rounded to 2 decimals (half up). */
export function productRowLineTotal(quantity: string, unitPrice: string): string {
  const cents = (scaled(quantity, 3) * scaled(unitPrice, 2) + 500n) / 1000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** Sum of canonical 2-decimal amounts; returns a canonical 2-decimal string. */
export function sumMoney(amounts: readonly string[]): string {
  const cents = amounts.reduce((total, amount) => total + scaled(amount, 2), 0n);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Canonical 2-decimal text for a Bitrix money-ish value; null when invalid. */
export function moneyText(value: unknown): string | null {
  const text = decimalText(value, MONEY_8DP_RE);
  if (text === null) return null;
  const negative = text.startsWith('-');
  const cents = (scaled(negative ? text.slice(1) : text, 8) + 500000n) / 1000000n;
  const sign = negative && cents !== 0n ? '-' : '';
  return `${sign}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function normalizeBitrixProductRow(
  raw: unknown,
): { row: Bitrix24ProductRow } | { invalid: Bitrix24ProductRowInvalid } {
  if (!isRecord(raw)) {
    return { invalid: { rowId: null, productId: null, code: 'BITRIX24_PRODUCT_ROW_SHAPE' } };
  }
  const rowId = positiveIdText(raw.id);
  if (rowId === null) {
    return {
      invalid: {
        rowId: null,
        productId: positiveIdText(raw.productId),
        code: 'BITRIX24_PRODUCT_ROW_SHAPE',
      },
    };
  }
  const productId = idText(raw.productId);
  if (productId === null) {
    return { invalid: { rowId, productId: null, code: 'BITRIX24_PRODUCT_ROW_SHAPE' } };
  }
  // Bitrix productId 0 marks a free-text custom row; it can never be mapped.
  if (productId === '0') {
    return {
      invalid: { rowId, productId, code: 'BITRIX24_PRODUCT_ROW_CUSTOM' },
    };
  }
  const quantity = fitDecimal(raw.quantity, QUANTITY_INT_DIGITS, QUANTITY_SCALE);
  const unitPrice = fitDecimal(raw.price, PRICE_INT_DIGITS, PRICE_SCALE);
  if (quantity === null || unitPrice === null || Number(quantity) <= 0) {
    return {
      invalid: { rowId, productId, code: 'BITRIX24_PRODUCT_ROW_PRECISION' },
    };
  }
  const lineTotal = productRowLineTotal(quantity, unitPrice);
  if (scaled(lineTotal, 2) > LINE_TOTAL_MAX_CENTS) {
    return {
      invalid: { rowId, productId, code: 'BITRIX24_PRODUCT_ROW_OVERFLOW' },
    };
  }
  const taxIncluded = raw.taxIncluded === null || raw.taxIncluded === undefined
    ? null
    : String(raw.taxIncluded).toUpperCase();
  if (taxIncluded !== null && taxIncluded !== 'Y' && taxIncluded !== 'N') {
    return {
      invalid: { rowId, productId, code: 'BITRIX24_PRODUCT_ROW_SHAPE' },
    };
  }
  const discountRate = provenanceDecimal(raw.discountRate);
  const discountSum = provenanceDecimal(raw.discountSum);
  const taxRate = provenanceDecimal(raw.taxRate);
  const sort = optionalInteger(raw.sort);
  const discountTypeId = optionalInteger(raw.discountTypeId);
  const measureCode = optionalInteger(raw.measureCode);
  if (
    raw.discountRate !== null && raw.discountRate !== undefined && discountRate === null ||
    raw.discountSum !== null && raw.discountSum !== undefined && discountSum === null ||
    raw.taxRate !== null && raw.taxRate !== undefined && taxRate === null ||
    raw.sort !== null && raw.sort !== undefined && sort === null
  ) {
    return {
      invalid: { rowId, productId, code: 'BITRIX24_PRODUCT_ROW_SHAPE' },
    };
  }
  const normalized: Bitrix24ProductRow = {
    rowId,
    productId,
    productName: cleanText(raw.productName),
    sort,
    quantity,
    unitPrice,
    lineTotal,
    discountTypeId,
    discountRate,
    discountSum,
    taxRate,
    taxIncluded: taxIncluded as 'Y' | 'N' | null,
    measureCode,
    measureName: cleanText(raw.measureName),
    raw,
    normalizedHash: '',
  };
  normalized.normalizedHash = hashProductRow(normalized);
  return { row: normalized };
}

export function hashProductRow(row: Omit<Bitrix24ProductRow, 'normalizedHash'>): string {
  return createHash('sha256').update(JSON.stringify([
    row.rowId,
    row.productId,
    row.productName,
    row.sort,
    row.quantity,
    row.unitPrice,
    row.lineTotal,
    row.discountTypeId,
    row.discountRate,
    row.discountSum,
    row.taxRate,
    row.taxIncluded,
    row.measureCode,
    row.measureName,
  ])).digest('hex');
}

/** Deterministic hash of the complete, validated remote row list. */
export function productRowsHash(rows: readonly Bitrix24ProductRow[]): string {
  const entries = rows
    .map((row) => row.normalizedHash)
    .sort();
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Fingerprint of one imported ERP catalog line (identity + financial shape). */
export function importedLineFingerprint(input: {
  orderLineId: number | null;
  bitrixRowId: string;
  catalogItemId: number;
  catalogVersion: number;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.orderLineId,
    input.bitrixRowId,
    input.catalogItemId,
    input.catalogVersion,
    input.quantity,
    input.unitPrice,
    input.lineTotal,
  ])).digest('hex');
}

/**
 * Fingerprint of the whole imported position of a request: the remote list
 * hash, the governing mapping versions, every imported line fingerprint and —
 * only when remote rows exist — the order financial totals bound to the Bitrix
 * opportunity at import time. An empty complete remote list never binds local
 * totals, so locally composed legacy requests keep working.
 */
export function productOrderFingerprint(input: {
  rowsHash: string;
  mappingVersions: readonly string[];
  importedLines: readonly string[];
  orderFinancials: {
    totalAmount: string;
    discount: string;
    surcharge: string;
    finalAmount: string;
  } | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    rowsHash: input.rowsHash,
    mappingVersions: [...input.mappingVersions].sort(),
    importedLines: [...input.importedLines].sort(),
    orderFinancials: input.orderFinancials,
  })).digest('hex');
}
