import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');

describe('order resource requirements list guards', () => {
  it('добавляет мультиселект-фильтры в заголовки с live-apply без закрытия', () => {
    expect(source).toContain('ResourceDemandFilterDropdown');
    expect(source).toContain('filterDropdown');
    expect(source).toContain('Включить все');
    expect(source).toContain('Сбросить');
    expect(source).toContain('Отключить все');
    expect(source).toContain('confirm({ closeDropdown: false })');
    expect(source).toContain('RESOURCE_FILTER_NONE');
    expect(source).toContain("filterProps('order', filterOptions.order)");
    expect(source).toContain("filterProps('date', filterOptions.date)");
    expect(source).not.toContain('filterOptions.orders');
    expect(source).not.toContain('filterOptions.dates');
  });

  it('позволяет независимо выбирать произвольные строки чекбоксами', () => {
    expect(source).toContain('selectedRowKeys');
    expect(source).toContain('setSelectedRowKeys');
    expect(source).toContain('rowSelection={{');
    expect(source).toContain('preserveSelectedRowKeys: true');
  });

  it('сортирует все видимые колонки списка', () => {
    expect(source).toContain("sortOrder={sortState.columnKey === 'order'");
    expect(source).toContain("sortOrder={sortState.columnKey === 'date'");
    expect(source).toContain("sortOrder={sortState.columnKey === 'sheetMaterials'");
    expect(source).toContain("sortOrder={sortState.columnKey === 'films'");
    expect(source).toContain('handleTableChange');
  });

  it('имеет отдельную кнопку полного сброса вида списка', () => {
    expect(source).toContain('Сбросить фильтры');
    expect(source).toContain('resetListView');
    expect(source).toContain('setReadyCutsOnly(false)');
    expect(source).toContain('setHeaderFilters(createDefaultHeaderFilters())');
    expect(source).toContain('setSortState(DEFAULT_SORT_STATE)');
    expect(source).toContain('setPage(DEFAULT_PAGE)');
    expect(source).not.toContain('setPageSize(DEFAULT_PAGE_SIZE)');
  });

  it('имеет быстрый фильтр периода «Сегодня» в одной строке шапки', () => {
    expect(source).toContain('Сегодня');
    expect(source).toContain('wrap={false}');
    expect(source).toContain("overflowX: 'auto'");
    expect(source).toContain("whiteSpace: 'nowrap'");
    expect(source).toContain('style={{ width: 220 }}');
    expect(source).toContain('setDateRange([today, today])');
  });

  it('имеет верхний чекбокс фильтра готовых раскроев', () => {
    expect(source).toContain('Готовые раскрои');
    expect(source).toContain('readyCutsOnly');
    expect(source).toContain('rowHasReadyCut');
    expect(source).toContain('film.hasCutData');
  });

  it('в колонке «Заказ» показывает номер заказа без кода проекта', () => {
    expect(source).toContain('orderDisplayNumber(row)');
    expect(source).toContain("return row.orderName?.trim() || `#${row.orderId}`;");
    expect(source).not.toContain('{row.fullNumber}</Link>');
    expect(source).toContain('compareText(orderDisplayNumber(left), orderDisplayNumber(right))');
  });

  it('добавляет отчет по текущим отфильтрованным строкам с предпросмотром и выгрузкой', () => {
    expect(source).toContain('Отчёт');
    expect(source).toContain('openReportModal');
    expect(source).toContain('setReportRows(tableRows)');
    expect(source).toContain('ResourceDemandReportModal');
    expect(source).toContain('ResourceDemandReportPreview');
    expect(source).toContain('downloadResourceDemandReport');
    expect(source).toContain('Формат отчёта');
    expect(source).toContain('Формат файла');
  });

  it('запоминает размер страницы через пользовательские настройки', () => {
    expect(source).toContain('usePageSizePreference');
    expect(source).toContain('order-resource-requirements:list');
    expect(source).toContain('PAGE_SIZE_OPTIONS');
    expect(source).toContain('rememberPageSize(nextPageSize)');
  });
});
