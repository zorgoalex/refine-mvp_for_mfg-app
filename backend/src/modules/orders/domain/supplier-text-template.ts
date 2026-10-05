/**
 * Шаблоны текста заявки поставщику (план 2026-10-02-supplier-text-templates-plan.md §2): только подстановка `{поле}`,
 * `{{`/`}}` — литеральные скобки, без выражений. Backend проверяет синтаксис и поля; рендер — на FE (та же грамматика,
 * общая фикстура `supplier-text-template.fixtures.json`).
 */
export const SUPPLIER_TEXT_BODY_FIELDS = ['номер', 'поставщик', 'дата', 'ожидаем_к', 'комментарий', 'позиции', 'позиций_всего'] as const;
export const SUPPLIER_TEXT_LINE_FIELDS = ['№', 'материал', 'количество', 'единица', 'количество_с_единицей'] as const;

/** `ownTemplates` — активных личных шаблонов на пользователя; `activeTemplates` — прежний лимит общих (общие через API не создаются). */
export const SUPPLIER_TEXT_LIMITS = { name: 80, body: 4000, line: 500, activeTemplates: 50, ownTemplates: 20 } as const;

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
