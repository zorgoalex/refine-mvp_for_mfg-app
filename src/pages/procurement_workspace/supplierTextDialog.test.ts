import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '../../api/httpClient';
import { isRouteMissing, supplierTextTemplatesApi } from '../../api/supplierTextTemplatesApi';
import type { SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import {
  nextTemplatesLoad,
  renderSupplierTextForCard,
  STANDARD_SUPPLIER_TEXT_TEMPLATE,
  supplierCopySource,
  supplierTextDialogText,
  supplierTextDisabledReason,
  templateSelectOptions,
} from './supplierTextTemplate';

const apiError = (status: number, code: string) => Object.assign(new Error(code), { status, code });
const template = (templateId: number, name: string, extra: Record<string, unknown> = {}) => ({
  templateId, name, body: '{номер}\n{позиции}', lineTemplate: '{материал}', isDefault: false, version: 1, updatedAt: '2026-10-04T00:00:00Z', ...extra,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('окно «Текст для поставщика» (замечания п.6, п.7)', () => {
  it('текст следует за шаблоном, пока его не правили; ручная правка помечается и снимается возвратом к шаблону', () => {
    expect(supplierTextDialogText('из шаблона', null)).toEqual({ text: 'из шаблона', edited: false });
    expect(supplierTextDialogText('из шаблона', 'поправил')).toEqual({ text: 'поправил', edited: true });
    // Правка, совпавшая с шаблоном, изменением не считается; пустой текст — тоже правка.
    expect(supplierTextDialogText('из шаблона', 'из шаблона')).toEqual({ text: 'из шаблона', edited: false });
    expect(supplierTextDialogText('из шаблона', '')).toEqual({ text: '', edited: true });
  });

  it('plan review R1-3: заявка на 100 позиций даёт текст длиннее 4096 символов — он не обрезается', () => {
    const card = {
      requestNumber: 'ЗП-26-0001', supplierName: 'Поставщик', expectedDate: null, comment: null, sentAt: null, createdAt: '2026-10-04T06:00:00.000Z',
      lineItems: Array.from({ length: 100 }, (_, index) => ({ name: `Материал с длинным названием для проверки длины текста ${index + 1}`, quantity: 12.5, unit: 'sheet' })),
    } as unknown as SupplierRequestCardDto;
    const rendered = renderSupplierTextForCard(STANDARD_SUPPLIER_TEXT_TEMPLATE, card);
    expect(rendered.length).toBeGreaterThan(4096);
    expect(supplierTextDialogText(rendered, null).text).toBe(rendered);
    expect(supplierTextDialogText(rendered, `${rendered}!`).text).toHaveLength(rendered.length + 1);
    expect(rendered).toContain('проверки длины текста 100');
    // В окне нет ограничения длины поля.
    expect(readFileSync('src/pages/procurement_workspace/SupplierTextDialog.tsx', 'utf8')).not.toMatch(/maxLength|\.slice\(/);
  });

  it('выбор шаблона: «Мои» выше «Общих», действующий по умолчанию помечен; шаблон старого backend (без scope) — общий', () => {
    expect(templateSelectOptions([
      template(1, 'Стандартный', { scope: 'shared' }), template(7, 'Мой короткий', { scope: 'own', isDefault: true }), template(2, 'Старый'),
    ])).toEqual([
      { label: 'Мои', options: [{ value: 7, label: 'Мой короткий (по умолчанию)' }] },
      { label: 'Общие', options: [{ value: 1, label: 'Стандартный' }, { value: 2, label: 'Старый' }] },
    ]);
    expect(templateSelectOptions([template(1, 'Стандартный', { scope: 'shared' })])).toEqual([{ label: 'Общие', options: [{ value: 1, label: 'Стандартный' }] }]);
  });
});

describe('plan review R6-1: недоступность шаблонов не отнимает текст заявки', () => {
  const ready = { status: 'ready' as const, templates: [template(1, 'Стандартный', { isDefault: true })] };

  it('capability выключен, сеть/5xx, пустой список — текст есть и кнопка доступна; редактор при этом скрыт', () => {
    for (const source of [
      supplierCopySource(undefined, { status: 'loading' }, null),
      supplierCopySource(false, { status: 'error' }, null),
      supplierCopySource(true, { status: 'error' }, null),
      supplierCopySource(true, { status: 'ready', templates: [] }, null),
      supplierCopySource(true, ready, null),
    ]) {
      expect(['legacy', 'fallback', 'template']).toContain(source.kind);
      expect(supplierTextDisabledReason(false, source)).toBeUndefined();
    }
    expect(supplierCopySource(true, { status: 'error' }, null)).toMatchObject({ kind: 'fallback', note: expect.stringContaining('стандартный текст') });
    // Редактор и выбор шаблона показываются только при прочитанном списке.
    expect(readFileSync('src/pages/procurement_workspace/SupplierTextDialog.tsx', 'utf8')).toContain("load.status === 'ready' && capability === true");
  });

  it('кнопка выключена только: загрузка, 401/403 (без подмены текста), несохранённые изменения заявки', () => {
    expect(supplierTextDisabledReason(false, supplierCopySource(true, { status: 'loading' }, null))).toBe('Загружаются шаблоны…');
    expect(supplierTextDisabledReason(false, supplierCopySource(true, { status: 'denied' }, null))).toMatch(/Нет прав/);
    expect(supplierTextDisabledReason(true, supplierCopySource(true, ready, null))).toBe('Сначала сохраните изменения');
    expect(supplierTextDisabledReason(true, supplierCopySource(undefined, { status: 'loading' }, null))).toBe('Сначала сохраните изменения');
  });
});

describe('code review R1-3: при открытии окна выбран действующий шаблон по умолчанию', () => {
  it('выбор внутри окна не запоминается между открытиями: без выбора — шаблон по умолчанию', () => {
    const templates = [template(1, 'A'), template(2, 'B', { isDefault: true })];
    expect(supplierCopySource(true, { status: 'ready', templates }, null)).toMatchObject({ kind: 'template', template: { templateId: 2 } });
    expect(supplierCopySource(true, { status: 'ready', templates }, 1)).toMatchObject({ kind: 'template', template: { templateId: 1 } });
    const dialog = readFileSync('src/pages/procurement_workspace/SupplierTextDialog.tsx', 'utf8');
    expect(dialog).toContain('setChosenId(null); setRefresh(');
    expect(dialog).not.toMatch(/readStoredTemplateId|storeTemplateId/);
  });
});

describe('code review R2-2: список шаблонов перечитывается при каждом открытии окна', () => {
  it('между открытиями в другой вкладке сменили шаблон по умолчанию A → B: новое открытие выбирает B', () => {
    const before = { status: 'ready' as const, templates: [template(1, 'A', { isDefault: true }), template(2, 'B')] };
    // Открытие: старый список остаётся на время обновления (кнопка не выключается)…
    expect(nextTemplatesLoad(before, { kind: 'start' })).toBe(before);
    // …свежий ответ заменяет его, и без выбора в окне берётся новый шаблон по умолчанию.
    const after = nextTemplatesLoad(before, { kind: 'ok', templates: [template(1, 'A'), template(2, 'B', { isDefault: true })] });
    expect(supplierCopySource(true, after, null)).toMatchObject({ kind: 'template', template: { templateId: 2 } });
    expect(readFileSync('src/pages/procurement_workspace/SupplierTextDialog.tsx', 'utf8')).toContain('setRefresh((value) => value + 1); setOpen(true)');
  });

  it('сбой обновления: прочитанный список остаётся; первого чтения нет — стандартный текст; 401/403 — доступ закрыт', () => {
    const ready = { status: 'ready' as const, templates: [template(1, 'A', { isDefault: true })] };
    expect(nextTemplatesLoad(ready, { kind: 'failed', status: 502 })).toBe(ready);
    expect(nextTemplatesLoad({ status: 'loading' }, { kind: 'failed', status: 0 })).toEqual({ status: 'error' });
    expect(nextTemplatesLoad({ status: 'error' }, { kind: 'start' })).toEqual({ status: 'loading' });
    expect(nextTemplatesLoad(ready, { kind: 'failed', status: 403 })).toEqual({ status: 'denied' });
  });
});

describe('личные шаблоны: маршруты (plan review R2-1, R3-1)', () => {
  it('«маршрута нет» — любой 404 без доменного кода', () => {
    expect(isRouteMissing(apiError(404, 'NOT_FOUND'))).toBe(true);
    expect(isRouteMissing(apiError(404, 'HTTP_404'))).toBe(true);
    expect(isRouteMissing(apiError(404, 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND'))).toBe(false);
    expect(isRouteMissing(apiError(503, 'SUPPLIER_TEXT_TEMPLATES_DISABLED'))).toBe(false);
  });

  it('чтение: новый маршрут; backend без него (откат) → прежний маршрут, только общие и только чтение', async () => {
    const get = vi.spyOn(httpClient, 'get');
    get.mockResolvedValueOnce({ templates: [template(7, 'Мой', { scope: 'own' })], canEditOwn: true, defaultRevision: 4 });
    expect(await supplierTextTemplatesApi.listVisible()).toMatchObject({ editable: true, defaultRevision: 4, templates: [{ templateId: 7 }] });
    expect(String(get.mock.calls[0][0])).toContain('/procurement/my-supplier-text-templates');

    get.mockReset();
    get.mockRejectedValueOnce(apiError(404, 'NOT_FOUND'));
    get.mockResolvedValueOnce({ templates: [template(1, 'Стандартный', { isDefault: true })], canManage: true });
    const fallback = await supplierTextTemplatesApi.listVisible();
    // Даже если старый backend говорит canManage=true — редактирования нет.
    expect(fallback).toEqual({ editable: false, defaultRevision: 0, templates: [expect.objectContaining({ templateId: 1, scope: 'shared' })] });
    expect(String(get.mock.calls[1][0])).toMatch(/\/procurement\/supplier-text-templates$/);

    // Другие ошибки (нет прав, флаг выключен) не подменяются чтением прежнего маршрута.
    get.mockReset();
    get.mockRejectedValueOnce(apiError(403, 'PERMISSION_DENIED'));
    await expect(supplierTextTemplatesApi.listVisible()).rejects.toMatchObject({ status: 403 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('команды уходят ТОЛЬКО на маршрут личных шаблонов и не переадресуются на прежний после 404', async () => {
    const calls: string[] = [];
    const fail = async (url: unknown) => { calls.push(String(url)); throw apiError(404, 'NOT_FOUND'); };
    vi.spyOn(httpClient, 'post').mockImplementation(fail as never);
    vi.spyOn(httpClient, 'patch').mockImplementation(fail as never);
    vi.spyOn(httpClient, 'delete').mockImplementation(fail as never);
    const key = '11111111-1111-4111-8111-111111111111';
    await expect(supplierTextTemplatesApi.create({ commandKey: key, name: 'a', body: '{номер}', lineTemplate: '{материал}' })).rejects.toMatchObject({ status: 404 });
    await expect(supplierTextTemplatesApi.update(5, { commandKey: key, expectedVersion: 1, name: 'b' })).rejects.toMatchObject({ status: 404 });
    await expect(supplierTextTemplatesApi.remove(5, { commandKey: key, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(supplierTextTemplatesApi.setDefault(5, { commandKey: key, expectedVersion: 1, expectedDefaultRevision: 0 })).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(4);
    expect(calls.every((url) => url.includes('/procurement/my-supplier-text-templates'))).toBe(true);
  });

  it('в исходниках FE нет записи на прежний маршрут; редактор — на экране снабжения, а не в Конфигурации', () => {
    const api = readFileSync('src/api/supplierTextTemplatesApi.ts', 'utf8');
    // Прежний маршрут (`shared`) используется единственный раз — чтением.
    expect(api.match(/shared\.(list|byId|setDefault)/g)).toEqual(['shared.list']);
    expect(api).toMatch(/httpClient\.get<SupplierTextTemplatesListDto>\(shared\.list/);
    for (const method of ['post', 'patch', 'delete']) expect(api).not.toMatch(new RegExp(`httpClient\\.${method}[^;]*shared\\.`));
    const settings = readFileSync('src/pages/configuration/components/ProcurementSettingsTab.tsx', 'utf8');
    expect(settings).not.toContain('SupplierTextTemplatesEditor');
    const card = readFileSync('src/pages/procurement_workspace/SupplierRequestsSection.tsx', 'utf8');
    expect(card).toContain('<SupplierTextDialog');
    expect(card).not.toContain('Скопировать текст для поставщика');
  });
});
