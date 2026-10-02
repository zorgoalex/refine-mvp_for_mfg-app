import type { SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import { formatRequestQuantity } from './supplierRequestsHelpers';
import { onecUnitLabel } from '../onec_purchase_documents/onecDocumentsHelpers';

/**
 * Шаблоны текста заявки поставщику — FE-копия грамматики backend (`backend/src/modules/orders/domain/
 * supplier-text-template.ts`, общая фикстура `supplier-text-template.fixtures.json`) + рендер (план §2).
 */
export const SUPPLIER_TEXT_BODY_FIELDS = ['номер', 'поставщик', 'дата', 'ожидаем_к', 'комментарий', 'позиции', 'позиций_всего'] as const;
export const SUPPLIER_TEXT_LINE_FIELDS = ['№', 'материал', 'количество', 'единица', 'количество_с_единицей'] as const;

export const SUPPLIER_TEXT_LIMITS = { name: 80, body: 4000, line: 500, activeTemplates: 50 } as const;

export type TemplateToken = { kind: 'text'; value: string } | { kind: 'field'; name: string };
export type TemplateErrorCode = 'UNCLOSED_BRACE' | 'STRAY_BRACE' | 'BAD_FIELD' | 'UNKNOWN_FIELD';

const FIELD_NAME = /^[\p{L}\p{N}_№]+$/u;

/** Однопроходный разбор; strict — ошибки синтаксиса, иначе ошибочные фрагменты становятся литералами. */
export function parseTemplate(template: string): { tokens: TemplateToken[]; error: { code: TemplateErrorCode; detail: string } | null } {
  const tokens: TemplateToken[] = [];
  let error: { code: TemplateErrorCode; detail: string } | null = null;
  let text = '';
  const flush = () => { if (text) { tokens.push({ kind: 'text', value: text }); text = ''; } };
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === '{' && template[i + 1] === '{') { text += '{'; i++; continue; }
    if (char === '}' && template[i + 1] === '}') { text += '}'; i++; continue; }
    if (char === '}') { error ??= { code: 'STRAY_BRACE', detail: template.slice(Math.max(0, i - 10), i + 1) }; text += char; continue; }
    if (char === '{') {
      const close = template.indexOf('}', i + 1);
      const newline = template.indexOf('\n', i + 1);
      if (close === -1 || (newline !== -1 && newline < close)) {
        error ??= { code: 'UNCLOSED_BRACE', detail: template.slice(i, i + 20) };
        text += char;
        continue;
      }
      const name = template.slice(i + 1, close);
      if (!FIELD_NAME.test(name)) {
        error ??= { code: 'BAD_FIELD', detail: name };
        text += template.slice(i, close + 1);
        i = close;
        continue;
      }
      flush();
      tokens.push({ kind: 'field', name });
      i = close;
      continue;
    }
    text += char;
  }
  flush();
  return { tokens, error };
}

/** Проверка шаблона: синтаксис и поля области (`body` — текст, `line` — строка позиции). */
export function validateTemplate(template: string, scope: 'body' | 'line'): { code: TemplateErrorCode; detail: string } | null {
  const { tokens, error } = parseTemplate(template);
  if (error) return error;
  const allowed: readonly string[] = scope === 'body' ? SUPPLIER_TEXT_BODY_FIELDS : SUPPLIER_TEXT_LINE_FIELDS;
  for (const token of tokens) {
    if (token.kind === 'field' && !allowed.includes(token.name)) return { code: 'UNKNOWN_FIELD', detail: token.name };
  }
  return null;
}

/** «Стандартный» — ровно прежний текст «Скопировать текст для поставщика». */
export const STANDARD_SUPPLIER_TEXT_TEMPLATE = {
  name: 'Стандартный',
  body: 'Заявка {номер} · {поставщик}\n{позиции}\nОжидаем к: {ожидаем_к}\n{комментарий}',
  line: '{материал} — {количество_с_единицей}',
} as const;

export type SupplierTextValues = Record<(typeof SUPPLIER_TEXT_BODY_FIELDS)[number], string>;
export type SupplierTextLineValues = Record<(typeof SUPPLIER_TEXT_LINE_FIELDS)[number], string>;

/**
 * Рендер: каждая строка шаблона разбирается один раз; значения вставляются литералами (без повторного разбора);
 * строка, где хоть одно поле пустое, выкидывается целиком; ошибочный синтаксис — литерал; хвостовые пустые строки
 * обрезаются. `{позиции}` — строки позиций по шаблону строки через перевод строки.
 */
export function renderSupplierText(
  template: { body: string; line: string },
  values: SupplierTextValues,
  lines: SupplierTextLineValues[],
): string {
  const renderLine = (source: string, lookup: (name: string) => string): string | null => {
    const { tokens } = parseTemplate(source);
    let out = '';
    for (const token of tokens) {
      if (token.kind === 'text') { out += token.value; continue; }
      const value = lookup(token.name);
      if (value === '') return null;
      out += value;
    }
    return out;
  };
  const positions = lines
    .map((line) => template.line.split('\n').map((part) => renderLine(part, (name) => (line as Record<string, string>)[name] ?? '')).filter((part): part is string => part !== null).join('\n'))
    .filter((text) => text !== '')
    .join('\n');
  const all: Record<string, string> = { ...values, позиции: positions };
  const result = template.body.split('\n')
    .map((part) => renderLine(part, (name) => all[name] ?? ''))
    .filter((part): part is string => part !== null);
  while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
  return result.join('\n');
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Дата Asia/Almaty ДД.ММ.ГГГГ из ISO-момента. */
export function almatyDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const [year, month, day] = parts.split('-');
  return `${day}.${month}.${year}`;
}

function dateOnly(value: string | null | undefined): string {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

const quantity3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

/** Значения полей из карточки заявки (план §2: дата — отправки, у черновика — создания). */
export function supplierTextValues(
  card: Pick<SupplierRequestCardDto, 'requestNumber' | 'supplierName' | 'expectedDate' | 'comment' | 'lineItems' | 'sentAt' | 'createdAt'>,
): { values: SupplierTextValues; lines: SupplierTextLineValues[] } {
  return {
    values: {
      номер: card.requestNumber,
      поставщик: card.supplierName ?? '',
      дата: almatyDate(card.sentAt ?? card.createdAt),
      ожидаем_к: dateOnly(card.expectedDate),
      комментарий: card.comment ?? '',
      позиции: '',
      позиций_всего: String(card.lineItems.length),
    },
    lines: card.lineItems.map((line, index) => ({
      '№': String(index + 1),
      материал: line.name,
      количество: quantity3.format(line.quantity),
      единица: onecUnitLabel(line.unit, null),
      количество_с_единицей: formatRequestQuantity(line.quantity, line.unit),
    })),
  };
}

export function renderSupplierTextForCard(
  template: { body: string; line: string },
  card: Parameters<typeof supplierTextValues>[0],
): string {
  const { values, lines } = supplierTextValues(card);
  return renderSupplierText(template, values, lines);
}

/** Подсказка полей для редактора. */
export const SUPPLIER_TEXT_FIELD_HELP: Record<string, string> = {
  номер: 'номер заявки', поставщик: 'поставщик', дата: 'дата отправки (у черновика — создания)', ожидаем_к: 'ожидаемая дата',
  комментарий: 'комментарий заявки', позиции: 'все позиции по «Строке позиции»', позиций_всего: 'число позиций',
  '№': 'номер позиции', материал: 'материал', количество: 'количество', единица: 'единица', количество_с_единицей: 'количество с единицей',
};

export interface SupplierTextTemplateLike {
  templateId: number;
  name: string;
  body: string;
  lineTemplate: string;
  isDefault: boolean;
}

/** Выбор шаблона: последний выбранный (если ещё есть) → по умолчанию → первый. */
export function pickSupplierTextTemplate<T extends SupplierTextTemplateLike>(templates: readonly T[], storedId: number | null): T | null {
  return templates.find((t) => t.templateId === storedId) ?? templates.find((t) => t.isDefault) ?? templates[0] ?? null;
}

export type SupplierTextTemplatesLoad<T extends SupplierTextTemplateLike = SupplierTextTemplateLike> =
  | { status: 'loading' }
  | { status: 'ready'; templates: T[] }
  | { status: 'error' }
  | { status: 'denied' };

export type SupplierCopySource<T extends SupplierTextTemplateLike = SupplierTextTemplateLike> =
  | { kind: 'legacy' }
  | { kind: 'template'; template: T }
  | { kind: 'fallback'; note: string }
  | { kind: 'loading' }
  | { kind: 'denied'; note: string };

/**
 * Чем копировать (план §6): нет capability (старый backend / флаг выключен) — прежний текст; список не загрузился —
 * «Стандартный» с явной пометкой; 401/403 — без подмены.
 */
export function supplierCopySource<T extends SupplierTextTemplateLike>(
  capability: boolean | undefined,
  load: SupplierTextTemplatesLoad<T>,
  storedId: number | null,
): SupplierCopySource<T> {
  if (capability !== true) return { kind: 'legacy' };
  if (load.status === 'loading') return { kind: 'loading' };
  if (load.status === 'denied') return { kind: 'denied', note: 'Нет прав на шаблоны текста поставщику' };
  if (load.status === 'error') return { kind: 'fallback', note: 'Шаблоны недоступны — стандартный текст' };
  const template = pickSupplierTextTemplate(load.templates, storedId);
  return template ? { kind: 'template', template } : { kind: 'fallback', note: 'Шаблонов нет — стандартный текст' };
}

export const SUPPLIER_TEXT_TEMPLATE_STORAGE_KEY = 'procurement.supplierTextTemplateId';

export function readStoredTemplateId(): number | null {
  try {
    const value = Number(globalThis.localStorage?.getItem(SUPPLIER_TEXT_TEMPLATE_STORAGE_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function storeTemplateId(templateId: number): void {
  try { globalThis.localStorage?.setItem(SUPPLIER_TEXT_TEMPLATE_STORAGE_KEY, String(templateId)); } catch { /* личное удобство */ }
}
