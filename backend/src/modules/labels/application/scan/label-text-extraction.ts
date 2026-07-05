export interface LabelTextFields {
  orderName?: string;
  detailNumber?: number;
  width?: number;
  height?: number;
  date?: string;
  material?: string;
}

// Shared regex constants, reused both by extractLabelFields (joined text) and
// by the per-line helpers below (used by the OCR template matcher).
const SIZE_PATTERN =
  /(?<![\dА-Яа-яA-Za-z])(\d{2,4})[\s]*[xхXХ×%]{1,2}[\s]*(\d{2,4})(?![\dА-Яа-яA-Za-z])/;
const MDF_PATTERN = /МДФ\s*(\d+)\s*мм/i;
const LDSP_PATTERN = /ЛДСП(?:\s*(\d+)\s*мм)?/i;
// dd.mm.yy(yy) — bazis labels carry both 2-digit (e.g. 00.00.17) and 4-digit years.
const DATE_PATTERN = /\b(\d{2})\.(\d{2})\.(\d{2}(?:\d{2})?)\b/;
const ORDER_NUMBER_PATTERN = /^\D*(\d{1,6})\D*$/;
const DETAIL_NUMBER_PATTERN = /^\D*(\d{1,5})\D*$/;
const QUANTITY_PATTERN = /(\d+)\s*ШТ/i;

/** Parses `width x height` (tolerant separators) from a single line. */
export function parseDimensions(line: string): { width: number; height: number } | null {
  const m = line.match(SIZE_PATTERN);
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Recognizes МДФ/ЛДСП material mentions on a single line; returns normalized material or null. */
export function matchesMaterial(line: string): string | null {
  const mdfMatch = line.match(MDF_PATTERN);
  if (mdfMatch) {
    return `МДФ ${mdfMatch[1]}мм`;
  }
  const ldspMatch = line.match(LDSP_PATTERN);
  if (ldspMatch) {
    return ldspMatch[1] ? `ЛДСП ${ldspMatch[1]}мм` : 'ЛДСП';
  }
  return null;
}

/** Parses a dd.mm.yyyy date from a single line. */
export function parseDate(line: string): string | null {
  const m = line.match(DATE_PATTERN);
  return m ? m[0] : null;
}

/** Whole-line (tolerant) order number: line is mostly one digit run 1-6 digits. */
export function parseOrderNumber(line: string): string | null {
  const m = line.match(ORDER_NUMBER_PATTERN);
  return m ? m[1] : null;
}

/** Whole-line (tolerant) detail number: integer in range 1..32767. */
export function parseDetailNumber(line: string): number | null {
  const m = line.match(DETAIL_NUMBER_PATTERN);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 32767) return null;
  return n;
}

/** Parses a quantity like "3 ШТ" from a single line. */
export function parseQuantity(line: string): number | null {
  const m = line.match(QUANTITY_PATTERN);
  return m ? parseInt(m[1], 10) : null;
}

export function extractLabelFields(lines: string[]): LabelTextFields {
  const text = lines.join(' ');
  const result: LabelTextFields = {};

  // Extract detail number (Поз/По3/etc.)
  // Pattern: По[зЗ3z] followed by 0-3 non-word chars, then digits
  const posMatch = text.match(/По[зЗ3z]\W{0,3}(\d+)/i);
  if (posMatch) {
    result.detailNumber = parseInt(posMatch[1], 10);
  }

  // Extract order name (from Заказ№: to Поз/Бир marker or end of text)
  // Stop at По[зЗ3z], Бир, or end of string
  const orderMatch = text.match(/Заказ№:\s*(.+?)(?:По[зЗ3z]|Бир|$)/i);
  if (orderMatch) {
    result.orderName = orderMatch[1].trim();
  }

  // Extract date (dd.mm.yyyy format)
  const date = parseDate(text);
  if (date) {
    result.date = date;
  }

  // Extract material (МДФ with mm size, or ЛДСП with optional mm size)
  const material = matchesMaterial(text);
  if (material) {
    result.material = material;
  }

  // Extract dimensions (width x height)
  // - 2-4 digit numbers
  // - Separated by x/X/х/Х/×/% (one or two chars)
  // - No letters/digits glued to numbers (word boundaries via lookbehind/lookahead)
  const dimensions = parseDimensions(text);
  if (dimensions) {
    result.width = dimensions.width;
    result.height = dimensions.height;
  }

  return result;
}
