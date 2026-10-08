import { describe, expect, it } from 'vitest';
import type { OnecSnapshotDto, OnecSnapshotItemDto } from '../../api/types/inventoryApi.types';
import {
  deltaTone, exportComplete, formatDelta, formatSnapshotMoment, isSnapshotActive, requestIntent, snapshotCapabilityReason, SNAPSHOT_EXPORT_LIMIT,
  snapshotExportRows, snapshotLabel, snapshotsMode, snapshotStatusDetail, toSnapshotMoment, viewFailureAction, warehousePlaceholder, warehouseScopeNote,
} from './onecSnapshots';

const snapshot = (over: Partial<OnecSnapshotDto> = {}): OnecSnapshotDto => ({
  id: 7, sourceId: 1, currentSource: true, baseRef: 'base-a', momentLocal: '2026-09-26T10:14:00', momentUtc: '2026-09-26T05:14:00.000Z', timeZone: 'Asia/Almaty',
  status: 'ready', waitReason: null, errorCode: null, requestedBy: { id: 3, name: 'u' }, requestedAt: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:01:00.000Z',
  readAt: null, readyAt: null, rowsCount: 1232, queuePosition: null, activeAhead: false, ...over,
});

describe('1C snapshot screen helpers', () => {
  it('formats the moment as the local time of the 1C base, without shifting the time zone', () => {
    expect(formatSnapshotMoment('2026-09-26T10:14:00')).toBe('26.09.2026 10:14');
    expect(formatSnapshotMoment('2026-09-27T00:00:05')).toBe('27.09.2026 00:00:05');
    expect(formatSnapshotMoment('bad')).toBe('bad');
    expect(snapshotLabel(snapshot())).toBe('№ 7 на 26.09.2026 10:14');
    expect(toSnapshotMoment({ format: (pattern) => pattern.replace('YYYY-MM-DDTHH:mm', '2026-09-26T10:14') })).toBe('2026-09-26T10:14:00');
    expect(toSnapshotMoment(null)).toBeNull();
  });

  it('explains a waiting or failed snapshot and keeps unknown codes visible', () => {
    expect(snapshotStatusDetail(snapshot({ status: 'requested', queuePosition: 3, waitReason: 'QUIET_WINDOW' }))).toBe('3-й в очереди, тихое окно агента');
    expect(snapshotStatusDetail(snapshot({ status: 'requested', queuePosition: 1, waitReason: null }))).toBeNull();
    expect(snapshotStatusDetail(snapshot({ status: 'failed', errorCode: 'TOO_MANY_ROWS' }))).toBe('слишком много строк в срезе');
    expect(snapshotStatusDetail(snapshot({ status: 'failed', errorCode: 'NEW_CODE' }))).toBe('NEW_CODE');
    expect(snapshotStatusDetail(snapshot({ status: 'syncing', queuePosition: 0 }))).toBeNull();
    expect(isSnapshotActive(snapshot({ status: 'syncing' }))).toBe(true);
    expect(isSnapshotActive(snapshot({ status: 'failed' }))).toBe(false);
    expect(snapshotCapabilityReason('AGENT_TOO_OLD')).toBe('агент 1С старее 1.3.11');
    expect(snapshotCapabilityReason(null)).toBe('запрос новых срезов недоступен');
  });

  it('four screen states: old backend or not connected — hidden; history only; full', () => {
    const page = { readAvailable: true, commandsAvailable: true, reason: null, items: [], total: 0 };
    expect(snapshotsMode(undefined, true)).toBe('hidden');
    expect(snapshotsMode({ ...page, readAvailable: false, commandsAvailable: false }, false)).toBe('hidden');
    expect(snapshotsMode({ ...page, commandsAvailable: false, reason: 'MODULE_DISABLED' }, false)).toBe('readonly');
    expect(snapshotsMode(page, false)).toBe('full');
    expect(snapshotsMode(undefined, false)).toBe('hidden');
  });

  it('exports rows with the comparison columns only when comparing; shows the sign of a delta', () => {
    const item: OnecSnapshotItemDto = {
      source: '1c', group: 'film', groupLabel: 'Плёнка', itemRefKey: 'k', code: 'F-1', name: 'Айвори', categoryKey: null, categoryName: 'Плёнка ПВХ',
      unitName: 'пог. м', quantity: 12.5, otherQuantity: 10, delta: -2.5, sheetMaterialTypeId: null, ambiguousLink: false,
    };
    expect(snapshotExportRows([item], false)).toEqual([{ Вкладка: 'Плёнка', Наименование: 'Айвори', 'Код 1С': 'F-1', 'Категория 1С': 'Плёнка ПВХ', 'В срезе': 12.5, 'Ед.': 'пог. м' }]);
    expect(snapshotExportRows([item], true)[0]).toMatchObject({ 'В срезе': 12.5, 'Вторая сторона': 10, Разница: -2.5 });
    expect([deltaTone(-2.5), deltaTone(0), deltaTone(3), deltaTone(null)]).toEqual(['minus', 'zero', 'plus', 'zero']);
    expect([formatDelta(3), formatDelta(-2.5), formatDelta(0), formatDelta(null)]).toEqual(['+3', '-2,5', '0', '—']);
  });

  it('a retry of the same request intent reuses its idempotency key; a new intent gets a new one', () => {
    let n = 0;
    const key = () => `key-${++n}`;
    const first = requestIntent(null, '2026-09-26T10:14:00', true, key);
    expect(first).toEqual({ momentLocal: '2026-09-26T10:14:00', force: true, key: 'key-1' });
    // Ответ потерян — пользователь повторяет то же действие: тот же ключ.
    expect(requestIntent(first, '2026-09-26T10:14:00', true, key)).toBe(first);
    expect(requestIntent(first, '2026-09-26T10:14:00', false, key).key).toBe('key-2');
    expect(requestIntent(first, '2026-09-27T00:00:00', true, key).key).toBe('key-3');
    // После подтверждённого успеха намерение сбрасывается (null) — следующий запрос с новым ключом.
    expect(requestIntent(null, '2026-09-26T10:14:00', true, key).key).toBe('key-4');
  });

  it('an export is one request for the whole view; an incomplete page is not written to a file', () => {
    expect(SNAPSHOT_EXPORT_LIMIT).toBe(40000);
    expect(exportComplete({ total: 2, items: [1, 2] })).toBe(true);
    expect(exportComplete({ total: 3, items: [1, 2] })).toBe(false);
    expect(exportComplete({ total: 0, items: [] })).toBe(true);
  });

  it('a deleted opened snapshot closes the view; a lost second side only drops the comparison', () => {
    const gone = { code: 'ONEC_STOCK_SNAPSHOT_NOT_FOUND', statusCode: 404 };
    expect(viewFailureAction('card', gone, false)).toBe('close');
    expect(viewFailureAction('card', gone, true)).toBe('close');
    expect(viewFailureAction('stock', gone, false)).toBe('close');
    // При сравнении со срезом 404 неоднозначен — карточка открытого среза ответит отдельно; здесь снимаем сравнение.
    expect(viewFailureAction('stock', gone, true)).toBe('drop-compare');
    expect(viewFailureAction('stock', { code: 'ONEC_SNAPSHOT_SOURCE_MISMATCH' }, true)).toBe('drop-compare');
    expect(viewFailureAction('stock', { code: 'ONEC_SNAPSHOT_COMPARE_UNAVAILABLE' }, false)).toBe('show');
    expect(viewFailureAction('card', { code: 'INTERNAL' }, false)).toBe('show');
    expect(viewFailureAction('stock', null, false)).toBe('show');
  });

  it('says which warehouses take part: all of the snapshot, or only ERP ones when comparing with the current stock', () => {
    const outside = ['Склад только 1С'];
    expect(warehouseScopeNote({ compareWith: undefined, selectedCount: 0, compared: [], outside })).toContain('Без выбора складов они входят в итог');
    expect(warehouseScopeNote({ compareWith: undefined, selectedCount: 1, compared: [], outside })).toBeNull();
    expect(warehouseScopeNote({ compareWith: 9, selectedCount: 0, compared: [], outside })).toContain('входят в итог');
    const current = warehouseScopeNote({ compareWith: 'current', selectedCount: 0, compared: [{ name: 'Распил' }, { name: 'Фрезеровка' }], outside });
    expect(current).toBe('Сравниваются склады ERP: Распил, Фрезеровка. Склады 1С, не заведённые в ERP, в сравнение с текущими остатками не входят: Склад только 1С.');
    expect(current).not.toContain('входят в итог');
    expect(warehouseScopeNote({ compareWith: 'current', selectedCount: 0, compared: undefined, outside: [] })).toBeNull();
    expect([warehousePlaceholder('current'), warehousePlaceholder(undefined), warehousePlaceholder(5)]).toEqual(['Все склады ERP, связанные с 1С', 'Все склады среза', 'Все склады среза']);
  });
});
