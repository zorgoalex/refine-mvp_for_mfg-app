/**
 * Незавершённая команда шаблонов (code review R1-1, R2-1): пока результат не подтверждён (успех или окончательный
 * отказ 4xx), команда хранится целиком — действие, шаблон, ИСХОДНОЕ тело и ключ. Повтор delete/default над тем же
 * шаблоном отправляет исходные ключ и тело (включая expectedVersion), даже если список уже обновился: сервер вернёт
 * сохранённый результат и не перезапишет более поздний выбор другого пользователя. У create/update исходная команда
 * повторяется, пока тело то же; изменённое тело — новая команда (update защищён expectedVersion).
 */
export type TemplateCommandAction = 'create' | 'update' | 'delete' | 'default';

export interface PendingCommand {
  action: TemplateCommandAction;
  templateId: number | null;
  body: Record<string, unknown>;
  signature: string;
  key: string;
}

export function commandSignature(action: string, templateId: number | null, body: unknown): string {
  return JSON.stringify([action, templateId, body]);
}

export function commandFor(
  pending: PendingCommand | null,
  action: TemplateCommandAction,
  templateId: number | null,
  body: Record<string, unknown>,
  makeId: () => string,
): PendingCommand {
  const signature = commandSignature(action, templateId, body);
  if (pending && pending.action === action && pending.templateId === templateId) {
    if (action === 'delete' || action === 'default' || pending.signature === signature) return pending;
  }
  return { action, templateId, body, signature, key: makeId() };
}

/**
 * Окончательный отказ — 4xx с кодом ошибки backend (R3-1). Локальные коды клиента (`HTTP_<status>` — тело ошибки не
 * прочитано, например HTML шлюза; `RESPONSE_PARSE_ERROR`), 5xx и отсутствие ответа — результат неизвестен.
 */
export function isDefinitiveFailure(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  if (typeof e?.status !== 'number' || e.status < 400 || e.status >= 500) return false;
  if (typeof e.code !== 'string' || e.code === '' || e.code === 'RESPONSE_PARSE_ERROR' || /^HTTP_\d+$/.test(e.code)) return false;
  return true;
}

const isTemplate = (value: unknown): boolean => {
  const t = value as Record<string, unknown> | null;
  return !!t && typeof t === 'object' && Number.isSafeInteger(t.templateId) && typeof t.name === 'string' && typeof t.body === 'string'
    && typeof t.lineTemplate === 'string' && typeof t.isDefault === 'boolean' && Number.isSafeInteger(t.version);
};

/** Ответ команды шаблонов той формы, что отдаёт backend (R3-2); иначе (пустой 200, HTML, другая форма) — результат неизвестен. */
export function isTemplateCommandResult(value: unknown): boolean {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r === 'object' && typeof r.changed === 'boolean' && (r.template === null || isTemplate(r.template))
    && Array.isArray(r.templates) && r.templates.every(isTemplate);
}

export type CommandOutcome<R> =
  | { outcome: 'ok'; result: R; pending: null }
  | { outcome: 'failed'; error: unknown; pending: null }
  | { outcome: 'uncertain'; error: unknown; pending: PendingCommand };

/** Выполнить команду с учётом незавершённой; вызывающий хранит возвращённый `pending`. */
export async function executeTemplateCommand<R>(
  pending: PendingCommand | null,
  action: TemplateCommandAction,
  templateId: number | null,
  body: Record<string, unknown>,
  call: (key: string, body: Record<string, unknown>) => Promise<R>,
  makeId: () => string,
  isValidResult: (value: unknown) => boolean = isTemplateCommandResult,
): Promise<CommandOutcome<R>> {
  const command = commandFor(pending, action, templateId, body, makeId);
  try {
    const result = await call(command.key, command.body);
    // Успех — только ответ ожидаемой формы; иначе команда сохраняется (повтор вернёт сохранённый результат).
    if (!isValidResult(result)) return { outcome: 'uncertain', error: new Error('Некорректный ответ сервера'), pending: command };
    return { outcome: 'ok', result, pending: null };
  } catch (error) {
    return isDefinitiveFailure(error) ? { outcome: 'failed', error, pending: null } : { outcome: 'uncertain', error, pending: command };
  }
}

export interface TemplateDraft {
  templateId: number | null;
  version: number;
  name: string;
  body: string;
  lineTemplate: string;
  /** Конфликт версии (R1-2): свежая версия с сервера; null — шаблон удалён. */
  conflict?: { fresh: { version: number; name: string; body: string; lineTemplate: string } | null };
}

/**
 * Разрешение конфликта открытого черновика по явному выбору пользователя: «theirs» — взять сохранённую версию,
 * «mine» — оставить свои правки поверх свежей версии (осознанная перезапись), «copy» — сохранить как новый шаблон
 * (когда исходный удалён или правки нужно сохранить отдельно).
 */
export function resolveDraftConflict(draft: TemplateDraft, choice: 'theirs' | 'mine' | 'copy'): TemplateDraft {
  const fresh = draft.conflict?.fresh ?? null;
  if (choice === 'copy' || !fresh) {
    return { templateId: null, version: 0, name: `${draft.name} (копия)`.slice(0, 80), body: draft.body, lineTemplate: draft.lineTemplate };
  }
  if (choice === 'theirs') {
    return { templateId: draft.templateId, version: fresh.version, name: fresh.name, body: fresh.body, lineTemplate: fresh.lineTemplate };
  }
  return { templateId: draft.templateId, version: fresh.version, name: draft.name, body: draft.body, lineTemplate: draft.lineTemplate };
}
