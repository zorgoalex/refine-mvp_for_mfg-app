// Компиляция пользовательского QR-шаблона бирки ({field}|{field}...) в парсер
// отсканированной строки. Чистые функции, без I/O.
const PLACEHOLDER = /\{([^{}]+)\}/g;

export interface CompiledQrTemplate {
  source: string;
  fieldIds: string[];
  prefix: string;
  separators: string[];
  suffix: string;
}

export function compileQrTemplate(contentTemplate: string): CompiledQrTemplate | null {
  const source = contentTemplate ?? '';
  if (!source.trim()) return null;

  const fieldIds: string[] = [];
  const literals: string[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    literals.push(source.slice(lastIndex, match.index));
    fieldIds.push(match[1].trim());
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  literals.push(source.slice(lastIndex));

  if (fieldIds.length === 0) return null;
  // Литералы между полями (не prefix/suffix) обязаны быть непустыми — иначе
  // разбиение неоднозначно ({x}{y}).
  const separators = literals.slice(1, -1);
  if (separators.some((s) => s.length === 0)) return null;

  return { source, fieldIds, prefix: literals[0], separators, suffix: literals[literals.length - 1] };
}

function stripAffixes(payload: string, compiled: CompiledQrTemplate): string | null {
  let rest = payload;
  if (compiled.prefix) {
    if (!rest.startsWith(compiled.prefix)) return null;
    rest = rest.slice(compiled.prefix.length);
  }
  if (compiled.suffix) {
    if (!rest.endsWith(compiled.suffix)) return null;
    rest = rest.slice(0, rest.length - compiled.suffix.length);
  }
  return rest;
}

function toParsed(compiled: CompiledQrTemplate, values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  compiled.fieldIds.forEach((fieldId, i) => {
    const value = values[i]?.trim();
    if (value) parsed[fieldId] = value;
  });
  return parsed;
}

export function parseQrPayload(payload: string, compiled: CompiledQrTemplate): Record<string, string> | null {
  let rest = stripAffixes(payload, compiled);
  if (rest == null) return null;
  const values: string[] = [];
  for (const sep of compiled.separators) {
    const idx = rest.indexOf(sep);
    if (idx < 0) return null;
    values.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  values.push(rest);
  return toParsed(compiled, values);
}

export function parseQrPayloadRight(payload: string, compiled: CompiledQrTemplate): Record<string, string> | null {
  // Право-якорный вариант: хвостовые поля отрезаются справа, всё лишнее
  // остаётся в ПЕРВОМ поле. Восстанавливает имя заказа с разделителем внутри.
  let rest = stripAffixes(payload, compiled);
  if (rest == null) return null;
  const tail: string[] = [];
  for (let i = compiled.separators.length - 1; i >= 0; i -= 1) {
    const sep = compiled.separators[i];
    const idx = rest.lastIndexOf(sep);
    if (idx < 0) return null;
    tail.unshift(rest.slice(idx + sep.length));
    rest = rest.slice(0, idx);
  }
  return toParsed(compiled, [rest, ...tail]);
}
