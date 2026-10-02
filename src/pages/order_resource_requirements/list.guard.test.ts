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

  it('имеет быстрый фильтр периода «Сегодня» в панели, которая переносится по ширине окна', () => {
    expect(source).toContain('Сегодня');
    // Панель фильтров переносится по ширине окна: одна строка, пока помещается, без горизонтальной прокрутки.
    expect(source).toContain('<Space wrap size={[8, 8]} style={{ width: \'100%\' }}>');
    expect(source).not.toContain('wrap={false}');
    expect(source).not.toContain("overflowX: 'auto'");
    expect(source).toContain("whiteSpace: 'nowrap'");
    expect(source).toContain('style={{ width: 220 }}');
    expect(source).toContain('setDateRange([today, today])');
  });

  it('имеет верхний чекбокс фильтра готовых раскроев', () => {
    expect(source).toContain('Готовые раскрои');
    expect(source).toContain('readyCutsOnly');
    expect(source).toContain('rowHasReadyCut');
    expect(source).toContain('film.hasCutData');
    expect(source).toContain('handleReadyCutsOnlyChange');
    expect(source).toContain('if (checked)');
    expect(source).toContain('setSelectedRowKeys([])');
    expect(source).toContain('setSelectedRowsByKey(new Map())');
  });

  it('в колонке «Заказ» номер заказа показан первым, код проекта — после него мелким серым текстом', () => {
    expect(source).toContain('<OrderNumber orderName={row.orderName} orderId={row.orderId} projectCode={row.projectCode} onClick={() => openCard(row)} />');
    expect(source).not.toContain('{row.fullNumber}</Link>');
    // Сортировка колонки — по номеру заказа, как раньше (без кода проекта).
    expect(source).toContain("return row.orderName?.trim() || `#${row.orderId}`;");
    expect(source).toContain('compareText(orderDisplayNumber(left), orderDisplayNumber(right))');
  });

  it('добавляет отчет по текущим отфильтрованным строкам с предпросмотром и выгрузкой', () => {
    expect(source).toContain('Отчёт');
    expect(source).toContain('openReportModal');
    expect(source).toContain('selectedRowsByKey');
    expect(source).toContain('handleRowSelectionChange');
    expect(source).toContain('selectedRowKeys.length > 0');
    expect(source).toContain('selectedRowsByKey.get(key)');
    expect(source).toContain(': tableRows');
    expect(source).toContain('setReportRows(rowsForReport)');
    expect(source).toContain('reportSelectedOnly');
    expect(source).toContain('<Typography.Text strong>отчёт только для выделенных заказов</Typography.Text>');
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

  it('фильтр «Документ 1С» гейтится по capabilities.onecDocuments', () => {
    expect(source).toContain('capabilities.onecDocuments && (');
    expect(source).toContain('capabilities.onecDocuments && onecDocumentFilter && (');
    expect(source).toContain('capabilities.onecDocuments && onecDocumentTruncatedHint && (');
    expect(source).toContain('aria-label="Документ 1С"');
  });

  it('фильтр «Документ 1С» участвует в query/byMaterialQuery, сбросе и «Сбросить фильтры»', () => {
    expect(source).toContain('onecDocumentFilter ? { onecDocumentId: onecDocumentFilter.documentId } : {}');
    expect(source).toContain('setOnecDocumentFilter(null)');
    expect(source).toContain('onecDocumentFilter != null ||');
  });

  it('опции Select строятся из onec-documents endpoint текущей выборки, не из глобального поиска по 1С', () => {
    expect(source).toContain('useOnecDocumentFilterOptions');
    expect(source).toContain('ordersApi.listResourceDemandOnecDocuments(query)');
    expect(source).toContain('buildOnecDocumentFilterOptionGroups(onecDocumentOptionsState.documents)');
    expect(source).toContain('ONEC_DOCUMENT_FILTER_DEBOUNCE_MS');
    expect(source).not.toContain('onecDocumentsApi.list({');
  });

  it('«По материалам» пропускает период по умолчанию, пока активен фильтр «Документ 1С»', () => {
    expect(source).toContain('resolveByMaterialPeriod(');
    expect(source).toContain('onecDocumentFilter != null,');
    expect(source).toContain('[dateRange, onecDocumentFilter, todayKey]');
  });

  it('тег активного фильтра «Документ 1С» закрывается сбросом фильтра', () => {
    expect(source).toContain('onecDocumentFilterTagText(onecDocumentFilter.label)');
    expect(source).toContain('onClose={() => handleOnecDocumentFilterChange(null)}');
  });

  it('deep link ?onecDocumentId= читается из URL один раз при монтировании и держится в синхронизации через replace', () => {
    expect(source).toContain("import { useSearchParams } from 'react-router-dom'");
    expect(source).toContain("parseOnecDocumentIdParam(searchParams.get('onecDocumentId'))");
    expect(source).toContain('onecDocumentsApi.getCard(initialDocumentId)');
    expect(source).toContain('onecDocumentFilterFallbackLabel(initialDocumentId)');
    expect(source).toContain('{ replace: true }');
  });
});
