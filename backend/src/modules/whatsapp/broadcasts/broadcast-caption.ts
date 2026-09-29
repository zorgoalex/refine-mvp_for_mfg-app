import { ApiError } from '../../../common/errors/api-error';

/** Caption of the first image. Stage A variables are dates only (plan §4.1, stage B adds totals). */
export const CAPTION_VARIABLES = [
  { name: 'current_date', label: 'Дата отправки', example: '30.09.2026' },
  { name: 'current_time', label: 'Время отправки', example: '08:45' },
  { name: 'weekday', label: 'День недели отправки', example: 'среда' },
  { name: 'target_date', label: 'Дата заказов', example: '01.10.2026' },
  { name: 'target_weekday', label: 'День недели заказов', example: 'четверг' },
] as const;

type CaptionVariable = (typeof CAPTION_VARIABLES)[number]['name'];
const KNOWN = new Set<string>(CAPTION_VARIABLES.map((variable) => variable.name));
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
/** WhatsApp caption limit. */
export const CAPTION_MAX_LENGTH = 1024;

type Token = { kind: 'text'; value: string } | { kind: 'variable'; name: CaptionVariable };

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
      tokens.push({ kind: 'variable', name: name as CaptionVariable });
      index = end;
      continue;
    }
    text += char;
  }
  if (text) tokens.push({ kind: 'text', value: text });
  return tokens;
}

/** Throws 422 for unknown variables or unbalanced braces; returns the normalized template. */
export function validateCaptionTemplate(template: string): string {
  tokenize(template);
  return template;
}

export function renderCaption(template: string, input: { now: Date; targetDate: string }): string {
  const values: Record<CaptionVariable, string> = {
    current_date: formatDate(almatyDate(input.now)),
    current_time: almatyTime(input.now),
    weekday: weekdayName(almatyDate(input.now)),
    target_date: formatDate(input.targetDate),
    target_weekday: weekdayName(input.targetDate),
  };
  const text = tokenize(template)
    .map((token) => (token.kind === 'text' ? token.value : values[token.name]))
    .join('')
    .trim();
  if (text.length > CAPTION_MAX_LENGTH) {
    throw new ApiError(422, 'BROADCAST_CAPTION_TOO_LONG', 'Подпись после подстановки длиннее 1024 символов.');
  }
  return text;
}

function invalid(message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', `Подпись: ${message}`);
}

function almatyDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function almatyTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function weekdayName(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}
