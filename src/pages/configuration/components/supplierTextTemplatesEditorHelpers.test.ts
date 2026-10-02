import { describe, expect, it } from 'vitest';
import { createApiErrorFromBody } from '../../../api/apiError';
import { commandFor, executeTemplateCommand, isDefinitiveFailure, isTemplateCommandResult, resolveDraftConflict, type PendingCommand, type TemplateDraft } from './supplierTextTemplatesEditorHelpers';

describe('pending template command', () => {
  let n = 0;
  const makeId = () => `key-${++n}`;
  const err = (status: number, code = 'X') => Object.assign(new Error('e'), { status, code });

  it('definitive = 4xx with a server error body; 5xx, parse error and network are uncertain', () => {
    expect(isDefinitiveFailure(err(409))).toBe(true);
    expect(isDefinitiveFailure(err(404))).toBe(true);
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
