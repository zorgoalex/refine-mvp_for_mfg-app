import { ApiError } from '../../../common/errors/api-error';

export const ORDER_SEND_CAPTION_VARIABLES = [
  { name: 'order_name', label: 'Номер заказа', example: '230725' },
  { name: 'client', label: 'Клиент', example: 'ИП Иванов' },
  { name: 'order_date', label: 'Дата заказа', example: '01.10.2026' },
  { name: 'completion_date', label: 'Дата сдачи', example: '15.10.2026' },
  { name: 'form', label: 'Форма', example: 'PDF заказа' },
] as const;

type Variable = (typeof ORDER_SEND_CAPTION_VARIABLES)[number]['name'];
const KNOWN = new Set<string>(ORDER_SEND_CAPTION_VARIABLES.map((variable) => variable.name));
export const ORDER_SEND_CAPTION_MAX = 1000;

type Token = { kind: 'text'; value: string } | { kind: 'variable'; name: Variable };

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    const next = template[index + 1];
    if (char === '{' && next === '{') { text += '{'; index += 1; continue; }
    if (char === '}' && next === '}') { text += '}'; index += 1; continue; }
    if (char === '}') throw invalid('Лишняя закрывающая скобка «}». Для самой скобки используйте «}}».');
    if (char === '{') {
      const end = template.indexOf('}', index + 1);
      if (end < 0) throw invalid('Не закрыта скобка «{». Для самой скобки используйте «{{».');
      const name = template.slice(index + 1, end);
      if (!KNOWN.has(name)) throw invalid(`Неизвестная переменная «{${name}}».`);
      if (text) { tokens.push({ kind: 'text', value: text }); text = ''; }
      tokens.push({ kind: 'variable', name: name as Variable });
      index = end;
      continue;
    }
    text += char;
  }
  if (text) tokens.push({ kind: 'text', value: text });
  return tokens;
}

export function validateOrderSendCaption(template: string): string {
  if (template.length > ORDER_SEND_CAPTION_MAX) throw invalid('Не длиннее 1000 символов.');
  tokenize(template);
  return template;
}

export function renderOrderSendCaption(template: string, values: Record<Variable, string>): string {
  const text = tokenize(template).map((token) => (token.kind === 'text' ? token.value : values[token.name])).join('').trim();
  // The stored caption is limited to 1000 characters (CHECK in migration 230).
  return text.length > ORDER_SEND_CAPTION_MAX ? `${text.slice(0, ORDER_SEND_CAPTION_MAX - 1)}…` : text;
}

function invalid(message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', `Подпись: ${message}`);
}
