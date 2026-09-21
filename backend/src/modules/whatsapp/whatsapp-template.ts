import { ApiError } from '../../common/errors/api-error';

export type MatchMode = 'contains_any' | 'exact_any' | 'pattern_exact' | 'pattern_contains';
export type BodyMode = 'text' | 'template';
export interface ReplyPattern { matchMode: MatchMode; keywords: string[] }
type Token = { literal: string } | { name: string; kind: 'number' | 'word' | 'text' };
const builtins = ['current_date', 'current_time', 'counter'];
const forbidden = new Set([...builtins, '__proto__', 'constructor', 'prototype']);
const clean = (text: string) => text.replace(/\s+/gu, ' ').trim();
const lower = (text: string) => text.toLocaleLowerCase('ru-RU');
function invalid(message: string): never { throw new ApiError(422, 'WHATSAPP_TEMPLATE_INVALID', message); }

function tokens(pattern: string): Token[] {
  if (!pattern || pattern.length > 120) invalid('Шаблон совпадения должен содержать от 1 до 120 символов');
  const parts: Token[] = [], names = new Set<string>();
  const source = clean(pattern);
  let pos = 0;
  for (const m of source.matchAll(/\{([a-z][a-z0-9_]{0,31}):(number|word|text)\}/g)) {
    const literal = source.slice(pos, m.index);
    if (/[{}]/.test(literal) || (parts.length && !literal)) invalid('Между полями шаблона нужен текст или пробел');
    if (literal) parts.push({ literal });
    if (forbidden.has(m[1]) || names.has(m[1]) || names.size >= 8) invalid('Имена полей должны быть уникальными, не служебными; максимум 8');
    names.add(m[1]);
    const kind = m[2];
    if (kind !== 'number' && kind !== 'word' && kind !== 'text') invalid('Неизвестный тип поля');
    parts.push({ name: m[1], kind });
    pos = m.index! + m[0].length;
  }
  const tail = source.slice(pos);
  if (/[{}]/.test(tail)) invalid('Используйте поля вида {order_number:number}, {name:word}, {note:text}');
  if (tail) parts.push({ literal: tail });
  return parts;
}

/** A bounded token matcher, never executes user-supplied regular expressions. */
export function matchReply(rule: ReplyPattern, text: string): Record<string, string> | null {
  if (text.length > 8192 || [...text].length > 4096) invalid('Сообщение длиннее 4096 символов');
  if (rule.matchMode === 'contains_any' || rule.matchMode === 'exact_any') {
    const input = lower(text.trim());
    return rule.keywords.some(key => rule.matchMode === 'exact_any' ? input === lower(key) : input.includes(lower(key))) ? {} : null;
  }
  const input = clean(text);
  let budget = 100_000; // Shared across all alternatives and starting offsets.
  const tick = () => { if (--budget < 0) throw new ApiError(422, 'WHATSAPP_PATTERN_LIMIT', 'Слишком сложное совпадение: уточните шаблон'); };
  for (const pattern of rule.keywords) {
    const parts = tokens(pattern), failed = new Set<string>();
    const visit = (part: number, offset: number): Record<string, string> | null => {
      tick();
      const key = `${part}:${offset}`;
      if (failed.has(key)) return null;
      if (part === parts.length) return rule.matchMode === 'pattern_contains' || offset === input.length ? {} : null;
      const token = parts[part];
      if ('literal' in token) {
        if (lower(input.slice(offset, offset + token.literal.length)) === lower(token.literal)) {
          const result = visit(part + 1, offset + token.literal.length);
          if (result) return result;
        }
      } else {
        // Longest capture first; failing states memoized independently of captures.
        let end = offset;
        const char = token.kind === 'number' ? /[0-9]/u : token.kind === 'word' ? /[\p{L}\p{N}_-]/u : /[\s\S]/u;
        while (end < input.length && char.test(input[end])) { tick(); end++; }
        for (; end > offset; end--) {
          tick();
          if (input[offset] === ' ' || input[end - 1] === ' ') continue;
          const rest = visit(part + 1, end);
          if (rest) return { ...rest, [token.name]: input.slice(offset, end) };
        }
      }
      failed.add(key);
      return null;
    };
    for (let offset = 0; offset <= (rule.matchMode === 'pattern_contains' ? input.length : 0); offset++) {
      const result = visit(0, offset);
      if (result) return result;
    }
  }
  return null;
}

function replyParts(body: string): { value: string; variable: boolean }[] {
  const parts: { value: string; variable: boolean }[] = [];
  for (let i = 0; i < body.length;) {
    if (body.startsWith('{{', i) || body.startsWith('}}', i)) { parts.push({ value: body[i], variable: false }); i += 2; }
    else if (body[i] === '{') {
      const match = /^\{([a-z][a-z0-9_]{0,31})\}/.exec(body.slice(i));
      if (!match || ['constructor', 'prototype'].includes(match[1])) invalid('Некорректная переменная ответа. Для скобок используйте {{ и }}');
      parts.push({ value: match[1], variable: true }); i += match[0].length;
    } else if (body[i] === '}') invalid('Незакрытая скобка в шаблоне ответа');
    else { parts.push({ value: body[i], variable: false }); i++; }
  }
  return parts;
}
export function replyVariables(body: string) { return [...new Set(replyParts(body).filter(p => p.variable).map(p => p.value))]; }

export function validateReply(rule: ReplyPattern, body: string, mode: BodyMode) {
  const fields = rule.keywords.map(pattern => rule.matchMode.startsWith('pattern_')
    ? tokens(pattern).flatMap(t => 'name' in t ? [t.name] : []) : []);
  if (mode === 'template') for (const variable of replyVariables(body)) {
    if (!builtins.includes(variable) && !fields.every(names => names.includes(variable)))
      invalid(`Переменная {${variable}} должна присутствовать во всех вариантах входящего шаблона`);
  }
}

export function renderReply(body: string, mode: BodyMode, captures: Record<string, string>, at: Date, counter: string): string {
  if (mode === 'text') return body;
  const values = { ...captures,
    current_date: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' }).format(at),
    current_time: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at), counter };
  const result = replyParts(body).map(p => {
    if (!p.variable) return p.value;
    if (!Object.hasOwn(values, p.value)) invalid(`Не найдено значение переменной {${p.value}}`);
    return values[p.value as keyof typeof values];
  }).join('');
  if (!result.trim() || [...result].length > 4096) invalid('Готовый ответ должен содержать от 1 до 4096 символов');
  return result;
}
