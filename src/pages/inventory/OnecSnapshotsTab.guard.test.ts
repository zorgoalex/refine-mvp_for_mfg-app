import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Срезы остатков 1С на дату: экран только читает и вызывает команды backend; показывается, только если сервер умеет.
const read = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');
const tab = read('OnecSnapshotsTab.tsx');
const page = read('FilmInventoryPage.tsx');
const api = read('../../api/inventoryApi.ts');

describe('1C stock snapshots screen guards', () => {
  it('the tab and the button appear only when the backend reports the capability; an old backend is not retried', () => {
    expect(page).toContain("queryFn: () => inventoryApi.onecSnapshots({ limit: 1 })");
    expect(page).toContain('enabled: viewAllowed, retry: false');
    expect(page).toContain("...(snapshotsState !== 'hidden' ? [{ key: 'onec-snapshots'");
    expect(page).toContain("snapshotsState === 'full' && manageAllowed && <Button");
    // Содержимое вкладки монтируется, только когда она открыта (опрос списка не идёт на других вкладках).
    expect(page).toContain("children: tab === 'onec-snapshots' ? <OnecSnapshotsTab");
  });

  it('commands need the manage permission and a server that accepts them; history stays readable without them', () => {
    // Возможности — из свежего ответа списка, а не только из запроса при открытии страницы.
    expect(tab).toContain('const liveMode = listQuery.data ? snapshotsMode(listQuery.data, false) : initialMode;');
    expect(tab).toContain("const canCommand = liveMode === 'full' && manageAllowed;");
    expect(tab).toContain('{canCommand && <Button type="primary" onClick={() => onRequestOpenChange(true)}>Запросить срез</Button>}');
    expect(tab).toContain('open={requestOpen && canCommand}');
    expect(tab).toContain("liveMode === 'readonly' && <Alert");
    expect(tab).toContain("{manageAllowed && row.status !== 'config_published' && row.status !== 'syncing' && <Popconfirm");
  });

  it('readiness is polled only while a snapshot is active; the moment is sent as the local time the user sees', () => {
    expect(tab).toContain('refetchInterval: (data) => (data?.items.some(isSnapshotActive) ? POLL_MS : false)');
    expect(tab).toContain('const momentLocal = toSnapshotMoment(moment);');
    expect(tab).not.toContain('toISOString()');
    expect(tab).toContain('00:00 следующего дня');
  });

  it('comparison is offered with the current stock only for a snapshot of the current 1C base, and with snapshots of the same base', () => {
    expect(tab).toContain("...(snapshot.currentSource ? [{ value: 'current' as const, label: 'текущими остатками 1С' }] : [])");
    // Кандидаты — запросом к серверу (база фильтруется до пагинации), с поиском по номеру или дате.
    expect(tab).toContain("inventoryApi.comparableOnecSnapshots(snapshotId, { search: candidateSearch.trim() || undefined, limit: COMPARE_PAGE })");
    expect(tab).toContain('showSearch filterOption={false} onSearch={setCandidateInput}');
    expect(tab).toContain('setTimeout(() => setCandidateSearch(candidateInput), SEARCH_DEBOUNCE_MS)');
    // Состав складов сравнения показывается по ответу сервера, а не по выбору в фильтре.
    expect(tab).toContain('warehouseScopeNote({ compareWith, selectedCount: warehouseIds.length, compared: data?.warehouses, outside })');
    expect(tab).toContain('placeholder={warehousePlaceholder(compareWith)}');
    expect(tab).toContain('Разница — вторая сторона минус срез');
  });

  it('a retried request reuses its idempotency key; the history is paged by the server; an opened snapshot does not depend on the list page', () => {
    expect(tab).toContain('intent.current = requestIntent(intent.current, momentLocal, force, createInventoryIdempotencyKey);');
    expect(tab).toContain("inventoryApi.requestOnecSnapshot({ momentLocal, ...(force ? { force: true } : {}) }, intent.current.key)");
    // Ключ сбрасывается только после подтверждённого ответа сервера.
    expect(tab.indexOf('intent.current = null;')).toBeGreaterThan(tab.indexOf('await inventoryApi.requestOnecSnapshot('));
    expect(tab).toContain('inventoryApi.onecSnapshots({ offset: (page.current - 1) * page.pageSize, limit: page.pageSize })');
    expect(tab).toContain('total: listQuery.data?.total ?? 0');
    expect(tab).toContain("queryFn: () => inventoryApi.onecSnapshot(snapshotId), retry: false");
    expect(tab).toContain("viewFailureAction('card', cardQuery.error as InventoryApiError, false) === 'close') onGone();");
    // Выгрузка — один запрос на всё представление (один снимок данных), без постраничной склейки.
    expect(tab).toContain('const all = await load({ ...params, offset: 0, limit: SNAPSHOT_EXPORT_LIMIT });');
    expect(tab).toContain('if (!exportComplete(all)) {');
    expect(tab).not.toMatch(/for \(let offset = 0/);
  });

  it('reads and commands go only through the backend inventory API; shared table and tooltip wrappers are used', () => {
    expect(tab).not.toMatch(/hasura|useUpdate|useCreate|useList|dataProvider/i);
    expect(tab).toContain("import { Table, Tooltip } from '../../ui/tooltipDelay';");
    expect(tab).not.toMatch(/import \{[^}]*\b(Table|Tooltip)\b[^}]*\} from 'antd'/);
    for (const route of ['/onec-snapshots`', '/onec-snapshots/${id}`', '/onec-snapshots/${id}/stock`', '/onec-snapshots/${id}/compare`', '/onec-snapshots/${id}/comparable`']) expect(api).toContain(route);
    expect(api).toContain('{ ...params, with: String(other) }');
  });
});
