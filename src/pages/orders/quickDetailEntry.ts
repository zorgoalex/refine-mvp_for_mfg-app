// «NewLine», мокап 05: строка быстрого ввода деталей «716×396×2» — высота × ширина × количество (мм, шт).
// Несколько деталей — по строке или через «;». Количество необязательно (1). Разделители: x, х (рус.), ×, *,
// пробел; «шт» после количества допускается; дробные размеры — через точку или запятую.

export interface QuickDetailRow {
  height: number;
  width: number;
  quantity: number;
}

export interface QuickDetailParse {
  rows: QuickDetailRow[];
  /** непонятые части ввода, как их ввели */
  invalid: string[];
}

export const QUICK_DETAIL_MAX_MM = 10_000;
export const QUICK_DETAIL_MAX_QUANTITY = 10_000;

const SEPARATOR = '\\s*[xх×*]\\s*|\\s+';
const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const ENTRY = new RegExp(`^${NUMBER}(?:${SEPARATOR})${NUMBER}(?:(?:${SEPARATOR})(\\d+)\\s*(?:шт\\.?)?)?$`, 'i');

const toNumber = (text: string): number => Number(text.replace(',', '.'));

export function parseQuickDetailEntry(input: string): QuickDetailParse {
  const rows: QuickDetailRow[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\n;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = ENTRY.exec(part);
    if (!match) {
      invalid.push(part);
      continue;
    }
    const height = toNumber(match[1]);
    const width = toNumber(match[2]);
    const quantity = match[3] === undefined ? 1 : Number(match[3]);
    const valid = [height, width].every((value) => value > 0 && value <= QUICK_DETAIL_MAX_MM)
      && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= QUICK_DETAIL_MAX_QUANTITY;
    if (valid) rows.push({ height, width, quantity });
    else invalid.push(part);
  }
  return { rows, invalid };
}
