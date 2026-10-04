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
 * 404 окончателен только с доменным кодом «шаблон не найден»: любой другой 404 — «маршрута нет» (backend откатили на
 * версию без личных шаблонов), команда при этом могла выполниться до отката — исход неизвестен (plan review R3-1).
 */
export function isDefinitiveFailure(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  if (typeof e?.status !== 'number' || e.status < 400 || e.status >= 500) return false;
  if (typeof e.code !== 'string' || e.code === '' || e.code === 'RESPONSE_PARSE_ERROR' || /^HTTP_\d+$/.test(e.code)) return false;
  if (e.status === 404 && e.code !== 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND') return false;
  return true;
}

/**
 * Пока исход команды неизвестен, другая команда не отправляется (R3-1): иначе выбор, сделанный за время сбоя в другой
 * вкладке, мог бы быть затёрт новой командой. Разрешён только повтор той же команды (исходные ключ и тело).
 */
export function isBlockedByPending(pending: PendingCommand | null, action: TemplateCommandAction, templateId: number | null, body: unknown): boolean {
  if (!pending) return false;
  if (pending.action !== action || pending.templateId !== templateId) return true;
  return action === 'create' || action === 'update' ? pending.signature !== commandSignature(action, templateId, body) : false;
}

const PENDING_LABELS: Record<TemplateCommandAction, string> = {
  create: 'создание шаблона', update: 'сохранение шаблона', delete: 'удаление шаблона', default: 'выбор шаблона по умолчанию',
};
export function pendingLabel(pending: PendingCommand): string {
  return PENDING_LABELS[pending.action];
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
  /**
   * Вызывается ДО отправки запроса с командой, которая уйдёт на сервер (code review R2-1): вызывающий сохраняет её вне
   * страницы, иначе перезагрузка во время запроса потеряла бы ключ уже выполненной команды.
   */
  beforeSend?: (command: PendingCommand) => void,
): Promise<CommandOutcome<R>> {
  const command = commandFor(pending, action, templateId, body, makeId);
  beforeSend?.(command);
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

/**
 * Список после подтверждённой команды (plan review R4-2, R5-2): ответ команды при повторе ключа — исторический
 * (например, показывает по умолчанию шаблон, который позже сменили в другой вкладке) и годится только как
 * подтверждение исхода. Показывается свежее чтение; если оно не удалось — `null`: вызывающий оставляет последний
 * прочитанный список и помечает его устаревшим, историческим ответом его не заменяет.
 */
export async function confirmedTemplates<L>(fetchList: () => Promise<L>): Promise<L | null> {
  try {
    return await fetchList();
  } catch {
    return null;
  }
}

/**
 * Незавершённые команды живут ВНЕ окна редактора (code review R1-1): окно можно закрыть и открыть снова, вкладку —
 * перезагрузить, а исходные ключ и тело должны дожить до подтверждения или явного сброса.
 *
 * Каждая команда — ОТДЕЛЬНАЯ запись localStorage с именем по пользователю и ключу команды (code review R5-2): вкладка
 * создаёт и удаляет только запись своей команды, общей перезаписываемой ячейки нет, поэтому между вкладками нечего
 * терять при любом чередовании операций (не нужна и блокировка «прочитал — записал»). Запись делается ДО отправки
 * запроса и обязана удаться (R5-1): если браузер не сохранил её, команда не отправляется.
 */
const PENDING_KEY_PREFIX = 'procurement.supplierTextTemplates.pending.';
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const browserStorage = (): PendingStorage | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};
const pendingName = (userId: string, key: string) => `${PENDING_KEY_PREFIX}${userId}.${key}`;

function isPendingCommand(value: unknown): value is PendingCommand {
  const p = value as Record<string, unknown> | null;
  return !!p && typeof p === 'object' && ['create', 'update', 'delete', 'default'].includes(p.action as string)
    && (p.templateId === null || Number.isSafeInteger(p.templateId)) && !!p.body && typeof p.body === 'object'
    && typeof p.signature === 'string' && typeof p.key === 'string' && p.key.length > 0;
}

/** Все незавершённые команды пользователя (обычно ни одной или одна), в порядке сохранения. */
export function listPendingCommands(userId: string, storage: PendingStorage | null = browserStorage()): PendingCommand[] {
  if (!storage) return [];
  const prefix = `${PENDING_KEY_PREFIX}${userId}.`;
  const found: Array<{ savedAt: number; command: PendingCommand }> = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (!name || !name.startsWith(prefix)) continue;
      try {
        const parsed = JSON.parse(storage.getItem(name) ?? 'null') as { savedAt?: unknown; command?: unknown } | null;
        if (parsed && isPendingCommand(parsed.command) && name === pendingName(userId, parsed.command.key)) {
          found.push({ savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0, command: parsed.command });
        }
      } catch { /* испорченная запись — не команда */ }
    }
  } catch {
    return [];
  }
  return found.sort((left, right) => left.savedAt - right.savedAt || left.command.key.localeCompare(right.command.key)).map((item) => item.command);
}

/**
 * Сохранить команду перед отправкой. true — запись есть и читается обратно; false — браузер её не сохранил (нет
 * хранилища, переполнение, запрет): отправлять команду нельзя, иначе после перезагрузки её ключ был бы потерян.
 */
export function addPendingCommand(userId: string, command: PendingCommand, storage: PendingStorage | null = browserStorage(), now: () => number = Date.now): boolean {
  if (!storage) return false;
  const name = pendingName(userId, command.key);
  try {
    // Повторная отправка той же команды время первой записи не меняет.
    if (storage.getItem(name) === null) storage.setItem(name, JSON.stringify({ savedAt: now(), command }));
    const parsed = JSON.parse(storage.getItem(name) ?? 'null') as { command?: unknown } | null;
    return !!parsed && isPendingCommand(parsed.command) && parsed.command.key === command.key;
  } catch {
    return false;
  }
}

/** Убрать запись СВОЕЙ команды (подтверждение, определённый отказ, явный сброс); чужие записи не затрагиваются. */
export function removePendingCommand(userId: string, key: string, storage: PendingStorage | null = browserStorage()): void {
  try { storage?.removeItem(pendingName(userId, key)); } catch { /* запись останется и будет показана как незавершённая */ }
}

/**
 * С какой незавершённой командой выполнять действие (code review R4-1, R6-1).
 * - «Повторить» — ВСЕГДА с показанной исходной командой (её ключ и тело) и ВСЕГДА разрешён: даже если её запись уже
 *   исчезла (другая вкладка подтвердила её — повтор с исходным ключом вернёт сохранённый результат) и даже если есть
 *   другие незавершённые команды (иначе две команды с потерянными ответами блокировали бы восстановление друг друга;
 *   они подтверждаются по очереди, каждая своим ключом).
 * - Новое действие: одна незавершённая команда — решает `isBlockedByPending`; несколько — конфликт, сначала их
 *   нужно завершить (показывается первая).
 */
export function pendingForRun(
  stored: readonly PendingCommand[],
  retry: PendingCommand | null,
): { pending: PendingCommand | null; conflict: PendingCommand | null } {
  if (retry) return { pending: retry, conflict: null };
  if (stored.length > 1) return { pending: stored[0], conflict: stored[0] };
  return { pending: stored[0] ?? null, conflict: null };
}
