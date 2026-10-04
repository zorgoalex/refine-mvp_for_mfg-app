import { describe, expect, it } from 'vitest';
import { createApiErrorFromBody } from '../../api/apiError';
import {
  addPendingCommand,
  commandFor,
  confirmedTemplates,
  executeTemplateCommand,
  isBlockedByPending,
  isDefinitiveFailure,
  isTemplateCommandResult,
  listPendingCommands,
  pendingForRun,
  resolveDraftConflict,
  removePendingCommand,
  type PendingCommand,
  type TemplateDraft,
} from './supplierTextTemplatesEditorHelpers';

describe('pending template command', () => {
  let n = 0;
  const makeId = () => `key-${++n}`;
  const err = (status: number, code = 'X') => Object.assign(new Error('e'), { status, code });

  it('definitive = 4xx with a server error body; 5xx, parse error and network are uncertain', () => {
    expect(isDefinitiveFailure(err(409))).toBe(true);
    // 404 окончателен только с доменным кодом; «маршрута нет» (откат backend) — исход неизвестен (plan review R3-1).
    expect(isDefinitiveFailure(err(404, 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND'))).toBe(true);
    expect(isDefinitiveFailure(err(404))).toBe(false);
    expect(isDefinitiveFailure(err(404, 'NOT_FOUND'))).toBe(false);
    expect(isDefinitiveFailure(err(404, 'HTTP_404'))).toBe(false);
    expect(isDefinitiveFailure(err(504))).toBe(false);
    expect(isDefinitiveFailure(err(200, 'RESPONSE_PARSE_ERROR'))).toBe(false);
    expect(isDefinitiveFailure(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('commit → 504 → another user picks B → retry of A sends the ORIGINAL key and version and gets the stored result', async () => {
    // Сервер: ключ → сохранённый результат; default меняется только новым ключом с актуальной версией.
    const okResult = { changed: true, template: null, templates: [] };
    const stored = new Map<string, typeof okResult>();
    let defaultId = 'old';
    let versionA = 1;
    const server = async (key: string, body: Record<string, unknown>) => {
      if (stored.has(key)) return stored.get(key)!;
      if (body.expectedVersion !== versionA) throw err(409, 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT');
      defaultId = 'A'; versionA += 1; stored.set(key, okResult);
      return okResult;
    };
    let pending: PendingCommand | null = null;
    const first = await executeTemplateCommand(pending, 'default', 7, { expectedVersion: 1 },
      async (key, body) => { await server(key, body); throw err(504); }, makeId);
    expect(first.outcome).toBe('uncertain');
    pending = first.pending;
    defaultId = 'B'; // позже другой пользователь выбрал B
    // Список обновился: у A теперь версия 2, клик снова на A.
    const retry = await executeTemplateCommand(pending, 'default', 7, { expectedVersion: 2 }, server, makeId);
    expect(retry).toMatchObject({ outcome: 'ok', result: okResult, pending: null });
    expect(defaultId).toBe('B');
  });

  it('delete: 502 keeps the command; a definitive 404 clears it', async () => {
    const keys: string[] = [];
    const a = await executeTemplateCommand(null, 'delete', 5, { expectedVersion: 2 }, async (key) => { keys.push(key); throw err(502); }, makeId);
    expect(a.outcome).toBe('uncertain');
    const b = await executeTemplateCommand(a.pending, 'delete', 5, { expectedVersion: 3 }, async (key, body) => { keys.push(key); expect(body).toEqual({ expectedVersion: 2 }); throw err(404, 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND'); }, makeId);
    expect(b).toMatchObject({ outcome: 'failed', pending: null });
    expect(keys[0]).toBe(keys[1]);
  });

  it('R3-1: a gateway 4xx without a backend error body (HTML 408) keeps the command; a backend 4xx is final', async () => {
    const gateway = createApiErrorFromBody(408, 'Request Timeout', null);
    expect(gateway.code).toBe('HTTP_408');
    expect(isDefinitiveFailure(gateway)).toBe(false);
    expect(isDefinitiveFailure(createApiErrorFromBody(409, 'Conflict', { error: { code: 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT', message: 'x' } } as never))).toBe(true);
    const first = await executeTemplateCommand(null, 'default', 7, { expectedVersion: 1 }, async () => { throw createApiErrorFromBody(504, 'Gateway Timeout', null); }, makeId);
    const second = await executeTemplateCommand(first.pending, 'default', 7, { expectedVersion: 2 }, async () => { throw gateway; }, makeId);
    expect(second.outcome).toBe('uncertain');
    expect(second.pending).toBe(first.pending);
    const third = await executeTemplateCommand(second.pending, 'default', 7, { expectedVersion: 2 }, async (key, body) => {
      expect(key).toBe(first.pending!.key);
      expect(body).toEqual({ expectedVersion: 1 });
      return { changed: true, template: null, templates: [] };
    }, makeId);
    expect(third).toMatchObject({ outcome: 'ok', pending: null });
  });

  it('R3-2: an empty 200, HTML or a wrong JSON shape is uncertain and keeps the command', async () => {
    for (const bad of [undefined, '<html>ok</html>', { ok: true }, { changed: true, templates: [{ templateId: 'x' }], template: null }]) {
      const done = await executeTemplateCommand(null, 'delete', 5, { expectedVersion: 2 }, async () => bad, makeId);
      expect(done.outcome).toBe('uncertain');
      expect(done.pending).toMatchObject({ action: 'delete', templateId: 5, body: { expectedVersion: 2 } });
    }
    const t = { templateId: 1, name: 'A', body: '{номер}', lineTemplate: '{материал}', isDefault: true, version: 2, updatedAt: '2026-10-02T00:00:00Z' };
    expect(isTemplateCommandResult({ changed: false, template: t, templates: [t] })).toBe(true);
  });

  it('another action or template, or a changed create/update body, is a new command', () => {
    const del = commandFor(null, 'delete', 5, { expectedVersion: 2 }, makeId);
    expect(commandFor(del, 'default', 5, { expectedVersion: 2 }, makeId).key).not.toBe(del.key);
    expect(commandFor(del, 'delete', 6, { expectedVersion: 2 }, makeId).key).not.toBe(del.key);
    const save = commandFor(null, 'update', 5, { name: 'A', expectedVersion: 1 }, makeId);
    expect(commandFor(save, 'update', 5, { name: 'A', expectedVersion: 1 }, makeId)).toBe(save);
    expect(commandFor(save, 'update', 5, { name: 'B', expectedVersion: 1 }, makeId).key).not.toBe(save.key);
  });
});

describe('draft version conflict', () => {
  const draft: TemplateDraft = {
    templateId: 5, version: 1, name: 'Мой', body: 'мой текст {номер}', lineTemplate: '{материал}',
    conflict: { fresh: { version: 2, name: 'Их', body: 'их текст {номер}', lineTemplate: '{материал} {количество}' } },
  };
  it('theirs loads the saved version; mine keeps the edits on the fresh version; both clear the conflict', () => {
    expect(resolveDraftConflict(draft, 'theirs')).toEqual({ templateId: 5, version: 2, name: 'Их', body: 'их текст {номер}', lineTemplate: '{материал} {количество}' });
    expect(resolveDraftConflict(draft, 'mine')).toEqual({ templateId: 5, version: 2, name: 'Мой', body: 'мой текст {номер}', lineTemplate: '{материал}' });
  });
  it('a deleted template or «copy» saves the edits as a new template', () => {
    expect(resolveDraftConflict({ ...draft, conflict: { fresh: null } }, 'mine')).toMatchObject({ templateId: null, version: 0, name: 'Мой (копия)', body: 'мой текст {номер}' });
    expect(resolveDraftConflict(draft, 'copy')).toMatchObject({ templateId: null, name: 'Мой (копия)' });
  });
});

describe('plan review R3-1: неизвестный исход после отката backend', () => {
  let n = 0;
  const makeId = () => `k-${++n}`;
  const okResult = { changed: true, template: null, templates: [] };

  it('default(X) выполнен → ответ потерян → маршрута нет (404) → команда сохранена → другой выбор Y → повтор K не затирает Y', async () => {
    const stored = new Map<string, typeof okResult>();
    let effective = 'old';
    let routeExists = true;
    let lose = true;
    const server = (target: string) => async (key: string) => {
      if (!routeExists) throw Object.assign(new Error('Cannot POST'), { status: 404, code: 'NOT_FOUND' });
      if (!stored.has(key)) { effective = target; stored.set(key, okResult); }
      if (lose) { lose = false; throw new TypeError('Failed to fetch'); }
      return stored.get(key)!;
    };
    let pending: PendingCommand | null = null;
    // 1) Команда выполнена, ответ потерян.
    let done = await executeTemplateCommand(pending, 'default', 1, { expectedVersion: 1 }, server('X'), makeId);
    expect(done.outcome).toBe('uncertain');
    pending = done.pending;
    const key = pending!.key;
    // 2) Backend откатили: 404 без доменного кода — исход по-прежнему неизвестен, ключ и тело те же.
    routeExists = false;
    done = await executeTemplateCommand(pending, 'default', 1, { expectedVersion: 1 }, server('X'), makeId);
    expect(done.outcome).toBe('uncertain');
    expect(done.pending).toMatchObject({ key, body: { expectedVersion: 1 } });
    pending = done.pending;
    // Пока исход неизвестен, другая команда этой вкладки не отправляется.
    expect(isBlockedByPending(pending, 'default', 2, { expectedVersion: 1 })).toBe(true);
    expect(isBlockedByPending(pending, 'create', null, { name: 'a' })).toBe(true);
    expect(isBlockedByPending(pending, 'default', 1, { expectedVersion: 7 })).toBe(false);
    // 3) Backend вернули; в другой вкладке выбран Y.
    routeExists = true;
    effective = 'Y';
    // 4) Повтор исходной команды: тот же ключ → сохранённый ответ, Y не затёрт.
    done = await executeTemplateCommand(pending, 'default', 1, { expectedVersion: 1 }, server('X'), makeId);
    expect(done).toMatchObject({ outcome: 'ok', pending: null });
    expect(effective).toBe('Y');
    expect([...stored.keys()]).toEqual([key]);
  });

  it('без незавершённой команды ничего не блокируется; изменённое тело create/update — другая команда и ждёт', () => {
    expect(isBlockedByPending(null, 'create', null, {})).toBe(false);
    const pending = commandFor(null, 'update', 5, { name: 'a', expectedVersion: 1 }, makeId);
    expect(isBlockedByPending(pending, 'update', 5, { name: 'a', expectedVersion: 1 })).toBe(false);
    expect(isBlockedByPending(pending, 'update', 5, { name: 'b', expectedVersion: 1 })).toBe(true);
  });
});

describe('plan review R4-2, R5-2: список после подтверждённой команды', () => {
  it('после повтора K показывается свежий список (Y по умолчанию), а не исторический ответ (X по умолчанию)', async () => {
    const fresh = { templates: [{ id: 'Y', isDefault: true }, { id: 'X', isDefault: false }], editable: true, defaultRevision: 2 };
    expect(await confirmedTemplates(async () => fresh)).toBe(fresh);
  });

  it('повтор K подтверждён, GET упал (5xx) — списка нет: историческим ответом он не заменяется', async () => {
    expect(await confirmedTemplates(async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }); })).toBeNull();
    // Редактор не подставляет templates из ответа команды.
    const { readFileSync } = await import('node:fs');
    const editor = readFileSync('src/pages/procurement_workspace/SupplierTextTemplatesEditor.tsx', 'utf8');
    expect(editor).not.toContain('done.result.templates');
    expect(editor).toContain('setStale(true)');
  });
});

describe('незавершённые команды вне окна редактора (code review R1-1 … R5)', () => {
  /** Хранилище как у браузера: общее для «вкладок»; `failSet` — запись падает (переполнение), чтение работает. */
  const storage = (options: { failSet?: boolean } = {}) => {
    const data = new Map<string, string>();
    return {
      data,
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { if (options.failSet) throw new Error('QuotaExceededError'); data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    };
  };
  const k1 = () => commandFor(null, 'default', 7, { expectedVersion: 1, expectedDefaultRevision: 0 }, () => 'K1');
  const k2 = () => commandFor(null, 'default', 8, { expectedVersion: 1, expectedDefaultRevision: 1 }, () => 'K2');
  let tick = 0;
  const now = () => ++tick;

  it('R1-1: после неизвестного исхода новое окно получает ту же команду (ключ и тело) и блокирует другие; у другого пользователя её нет', () => {
    const store = storage();
    expect(addPendingCommand('42', k1(), store, now)).toBe(true);
    const reopened = listPendingCommands('42', store);
    expect(reopened).toEqual([k1()]);
    expect(isBlockedByPending(reopened[0], 'default', 8, { expectedVersion: 1, expectedDefaultRevision: 0 })).toBe(true);
    expect(commandFor(reopened[0], 'default', 7, { expectedVersion: 3, expectedDefaultRevision: 5 }, () => 'new').key).toBe('K1');
    expect(listPendingCommands('43', store)).toEqual([]);
    expect(listPendingCommands('4', store)).toEqual([]);
    removePendingCommand('42', 'K1', store);
    expect(listPendingCommands('42', store)).toEqual([]);
  });

  it('R2-1: команда сохраняется ДО отправки — перезагрузка во время запроса не теряет ключ выполненной команды', async () => {
    const store = storage();
    const events: string[] = [];
    let sent: PendingCommand | null = null;
    // Запрос «завис»: сервер команду выполнил, ответа нет, страницу перезагружают.
    void executeTemplateCommand(null, 'default', 7, { expectedVersion: 1, expectedDefaultRevision: 0 },
      (key) => { events.push(addPendingCommand('42', sent!, store, now) ? 'saved' : 'not-saved'); events.push(`sent:${key}`); return new Promise<never>(() => undefined); },
      () => 'K1', undefined, (command) => { sent = command; });
    await Promise.resolve();
    expect(events).toEqual(['saved', 'sent:K1']);
    const reloaded = listPendingCommands('42', store);
    expect(reloaded).toMatchObject([{ key: 'K1', action: 'default', templateId: 7, body: { expectedVersion: 1, expectedDefaultRevision: 0 } }]);
    const retry = await executeTemplateCommand(reloaded[0], 'default', 7, { expectedVersion: 1, expectedDefaultRevision: 3 },
      async (key, body) => { expect(key).toBe('K1'); expect(body).toEqual({ expectedVersion: 1, expectedDefaultRevision: 0 }); return { changed: true, template: null, templates: [] }; },
      () => 'other');
    expect(retry.outcome).toBe('ok');
  });

  it('R5-1: запись падает (переполнение), чтение работает — команда НЕ считается сохранённой и не отправляется', async () => {
    const store = storage({ failSet: true });
    expect(addPendingCommand('42', k1(), store, now)).toBe(false);
    expect(addPendingCommand('42', k1(), null, now)).toBe(false);
    expect(listPendingCommands('42', store)).toEqual([]);
    // Редактор: без сохранённой записи запрос не уходит.
    const { readFileSync } = await import('node:fs');
    const editor = readFileSync('src/pages/procurement_workspace/SupplierTextTemplatesEditor.tsx', 'utf8');
    expect(editor).toContain('if (!sent || !addPendingCommand(userId, sent)) throw new PendingNotSavedError();');
    expect(editor.indexOf('addPendingCommand(userId, sent)')).toBeLessThan(editor.indexOf('return call(key, sentBody);'));
    expect(editor).toContain('оно не отправлено');
  });

  it('R3-1, R5-2: каждая команда — своя запись: запоздалый ответ K1 и любые чередования вкладок не трогают K2', () => {
    const store = storage();
    addPendingCommand('42', k1(), store, now);
    // Вкладка B: K1 подтверждена, отправлена K2. Вкладка A в это же время «завершает» K1 — в любом порядке.
    removePendingCommand('42', 'K1', store);
    addPendingCommand('42', k2(), store, now);
    removePendingCommand('42', 'K1', store); // поздний успех K1 из закрытого окна / сброс показанной K1 (R4-2)
    expect(listPendingCommands('42', store)).toEqual([k2()]);
    // Обе вкладки увидели пусто и отправили каждая своё: ни одна запись не затёрта.
    removePendingCommand('42', 'K2', store);
    addPendingCommand('42', k1(), store, now);
    addPendingCommand('42', k2(), store, now);
    expect(listPendingCommands('42', store).map((command) => command.key)).toEqual(['K1', 'K2']);
    // Запись содержит только свою команду: имя включает ключ.
    expect([...store.data.keys()]).toEqual(['procurement.supplierTextTemplates.pending.42.K1', 'procurement.supplierTextTemplates.pending.42.K2']);
    // Поздний сетевой отказ K1 после её сброса запись не возвращает: при неизвестном исходе редактор в хранилище не пишет.
    removePendingCommand('42', 'K1', store);
    expect(listPendingCommands('42', store)).toEqual([k2()]);
  });

  it('R4-1: «Повторить» идёт с исходным ключом, даже если запись уже исчезла; другая незавершённая команда — конфликт', async () => {
    const shown = commandFor(null, 'create', null, { name: 'Мой', body: '{номер}', lineTemplate: '{материал}' }, () => 'K1');
    // Другая вкладка подтвердила K1 и очистила запись.
    const plan = pendingForRun([], shown);
    expect(plan).toEqual({ pending: shown, conflict: null });
    const keys: string[] = [];
    const done = await executeTemplateCommand(plan.pending, shown.action, shown.templateId, shown.body,
      async (key) => { keys.push(key); return { changed: true, template: null, templates: [] }; }, () => 'NEW');
    expect(done.outcome).toBe('ok');
    expect(keys).toEqual(['K1']);
    // Повтор разрешён и при других незавершённых командах (R6-1).
    expect(pendingForRun([k2()], k1())).toEqual({ pending: k1(), conflict: null });
    expect(pendingForRun([k1()], k1())).toEqual({ pending: k1(), conflict: null });
    // Обычное действие: одна незавершённая — с ней (блокировку решает isBlockedByPending); две — конфликт.
    expect(pendingForRun([], null)).toEqual({ pending: null, conflict: null });
    expect(pendingForRun([k1()], null)).toEqual({ pending: k1(), conflict: null });
    expect(pendingForRun([k1(), k2()], null)).toMatchObject({ conflict: { key: 'K1' } });
  });

  it('R6-1: две вкладки → два неизвестных исхода → обе команды подтверждаются по очереди своими ключами, без сброса и повторных эффектов', async () => {
    const store = storage();
    // Сервер: ключ → сохранённый результат; эффект — один раз на ключ.
    const effects: string[] = [];
    const server = async (key: string) => { if (!effects.includes(key)) effects.push(key); return { changed: true, template: null, templates: [] }; };
    // Обе вкладки сохранили и отправили свои команды; сервер выполнил обе, оба ответа потеряны.
    addPendingCommand('42', k1(), store, now);
    addPendingCommand('42', k2(), store, now);
    await server('K1'); await server('K2');
    // Восстановление: показывается первая, её повтор разрешён несмотря на вторую.
    let stored = listPendingCommands('42', store);
    expect(stored.map((command) => command.key)).toEqual(['K1', 'K2']);
    // Новое действие при этом не отправляется.
    expect(pendingForRun(stored, null).conflict).not.toBeNull();
    for (const expected of ['K1', 'K2']) {
      stored = listPendingCommands('42', store);
      const shown = stored[0];
      expect(shown.key).toBe(expected);
      const plan = pendingForRun(stored, shown);
      expect(plan).toEqual({ pending: shown, conflict: null });
      const sentKeys: string[] = [];
      const done = await executeTemplateCommand(plan.pending, shown.action, shown.templateId, shown.body,
        (key) => { sentKeys.push(key); return server(key); }, () => 'NEW');
      expect(done.outcome).toBe('ok');
      expect(sentKeys).toEqual([expected]);
      removePendingCommand('42', shown.key, store);
    }
    expect(listPendingCommands('42', store)).toEqual([]);
    expect(effects).toEqual(['K1', 'K2']);
    expect(pendingForRun([], null)).toEqual({ pending: null, conflict: null });
  });

  it('испорченная или чужая по имени запись командой не считается', () => {
    const store = storage();
    store.setItem('procurement.supplierTextTemplates.pending.78.X', '{"command":{"action":"drop"}}');
    store.setItem('procurement.supplierTextTemplates.pending.78.Y', JSON.stringify({ savedAt: 1, command: k1() }));
    store.setItem('procurement.supplierTextTemplates.pending.78.Z', 'not json');
    expect(listPendingCommands('78', store)).toEqual([]);
  });

  it('редактор: запись до отправки, удаление только своей записи, сброс по ключу показанной команды', async () => {
    const { readFileSync } = await import('node:fs');
    const editor = readFileSync('src/pages/procurement_workspace/SupplierTextTemplatesEditor.tsx', 'utf8');
    expect(editor).toContain("if (done.outcome !== 'uncertain' && sentCommand) removePendingCommand(userId, sentCommand.key);");
    expect(editor).toContain('removePendingCommand(userId, key);');
    expect(editor).toContain('pendingForRun(listPendingCommands(userId), retry)');
    expect(editor).not.toMatch(/savePendingCommand|settlePendingCommand|setPending\(/);
  });
});
