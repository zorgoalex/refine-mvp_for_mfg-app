import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./OrderDetailTable.tsx', import.meta.url)),
  'utf8',
);
const appStyles = readFileSync(
  fileURLToPath(new URL('../../../../styles/app.css', import.meta.url)),
  'utf8',
);

describe('OrderDetailTable interaction performance guards', () => {
  it('limits form-driven cell updates to changed and editing rows', () => {
    expect(source).toContain('interface OrderDetailCellRuntime');
    expect(source).toContain('runtime.listenersByCell.get(normalizedCellKey)?.forEach');
    expect(source).toContain('cellRuntime.notifyCell(previousEditingKey, previousEditingField)');
    expect(source).toContain('cellRuntime.notifyRowState(previousEditingKey)');
    expect(source).toContain("cellRuntime.notifyCell(previousEditingKey, 'actions')");
    expect(source).toContain("cellRuntime.notifyCell(editingKey, 'actions')");
    expect(source).toContain('shouldCellUpdate: (row: any, previousRow: any) => row !== previousRow');
  });

  it('does not combine smooth scrolling with an automatic focus scroll', () => {
    const effectStart = source.lastIndexOf('if (editingKey == null) return;');
    const effectEnd = source.indexOf(
      '}, [currentPage, editingField, editingKey, groupingActive]);',
      effectStart,
    );
    const editingFocusEffect = source.slice(effectStart, effectEnd);

    expect(editingFocusEffect).toContain(
      "scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })",
    );
    expect(source).toContain("'data-order-detail-column-key': String(key)");
    expect(editingFocusEffect).toContain(
      'findOrderDetailInlineEditor(row ?? null, String(editingField))',
    );
    expect(editingFocusEffect).toContain('focusOrderDetailInlineEditorAtEnd(');
    expect(editingFocusEffect).not.toContain(
      "row?.querySelector<HTMLElement>('input, textarea, [role=\"combobox\"]')",
    );
    expect(editingFocusEffect).not.toContain("behavior: 'smooth'");
  });

  it('keeps table and active-cell geometry stable', () => {
    expect(source).toContain('tableLayout="fixed"');
    expect(source).toContain('scroll={{ x: tableScrollWidth, y: tableBodyScrollY }}');
    expect(source).toContain('calculateOrderDetailTableBodyScrollY(filledDetailRowsCount, details.length)');
    expect(source).toContain("editing ? 'order-detail-row-editing dg-editing' : ''");
    expect(appStyles).toContain('td.order-detail-spreadsheet-cell:focus');
    expect(appStyles).toContain('inset 0 0 0 2px var(--order-detail-grid-accent)');
    expect(source).not.toContain('backgroundColor: isCurrentlyEditing');
    expect(source).not.toContain("transform: isCurrentlyEditing ? 'scale(1.01)'");
    expect(source).not.toContain("border: isCurrentlyEditing ? '2px solid #faad14'");
  });

  it('keeps the rc-table data source stable during local form state changes', () => {
    expect(source).toContain('const paginatedDetails = useMemo(');
    expect(source).toContain(
      '() => sortOrderDetailsForPagination(realSortedDetails, activeCompare, activeSorter.order)',
    );
    expect(source).toContain('[activeCompare, activeSorter.order, realSortedDetails]');
    expect(source).toContain("activeSorter.key === 'sheet_material_type_id'");
    expect(source).toContain('[activeSheetMaterialNames, activeSorter.key]');
  });

  it('keeps the AntD selection column stable during inline editing', () => {
    expect(source).toContain('const onSelectChangeRef = useRef(onSelectChange);');
    expect(source).toContain('const rowSelection = useMemo(() => onSelectChangeRef.current');
    expect(source).toContain('[cutSelectable, selectedRowKeys]');
  });

  it('keeps the rc-table column structure stable while delegating current callbacks', () => {
    expect(source).toContain('function useStableOrderDetailColumns');
    expect(source).toContain('<LiveOrderDetailCell columnKey={key}');
    expect(source).toContain('runtime?.renderByKey.get(columnKey)');
    expect(source).toContain('const stableRenderedColumns = useStableOrderDetailColumns(renderedColumns, cellRuntime);');
    expect(source).toContain('columns={stableRenderedColumns}');
    expect(source).toContain('<OrderDetailCellRuntimeContext.Provider value={cellRuntime}>');
  });

  it('does not rerender the full AntD table for edit-only state', () => {
    expect(source).toContain('const MemoizedOrderDetailTable = React.memo(');
    expect(source).toContain('previous.renderVersion === current.renderVersion');
    expect(source).toContain('<MemoizedOrderDetailTable');
    expect(source).toContain('renderVersion={tableRenderVersion}');
    expect(source).toContain('row: OrderDetailBodyRow');
  });

  it('mounts only the active cell editor while preserving row edit state', () => {
    expect(source).toContain('const [editingField, setEditingField] = useState<React.Key | null>(');
    expect(source).toContain("isEditing(record) && editingField === field");
    expect(source).toContain('isSpreadsheetCellEditable(column.key)');
    expect(source).toContain('setEditingField(columnKey)');
    expect(source).toContain('if (!clickedInteractiveChild) setEditingField(null);');
    expect(source).toContain('onKeyDownCapture={handleInlineEditorKeyDown}');
    expect(source).toContain('nextOrderDetailInlineTabField(');
    expect(source).toContain('void finishInlineEditOnTab(record).then((saved) =>');
    expect(source).toContain('await finishOrderDetailInlineTab({');
    expect(source).toContain('const validateInlineForm = useCallback');
  });

  it('wires Excel-style cell focus, keyboard navigation, and direct editing', () => {
    expect(source).toContain("'data-order-detail-spreadsheet-cell': 'true'");
    expect(source).toContain("ArrowUp: 'up'");
    expect(source).toContain("ArrowDown: 'down'");
    expect(source).toContain("event.key === 'Enter' || event.key === 'F2'");
    expect(source).toContain('orderDetailSpreadsheetTypedValue(columnKey, event.key)');
    expect(source).toContain('if (initialValue === null) return;');
    expect(source).toContain('editingKey !== null && editingField !== null');
    expect(source).toContain('focusOrderDetailInlineEditorAtEnd(');
    expect(source).toContain('if (!clickedInteractiveChild) setEditingField(null);');
    expect(source).toContain('orderDetailSpreadsheetPastedValue(');
    expect(source).toContain("event.clipboardData.setData('text/plain'");
    expect(source).toContain('void beginSpreadsheetCellEdit(detail, column.key)');
    expect(source).toContain('focusSpreadsheetCoordinate(nextCell)');
    expect(source).toContain('cancelEdit();');
    expect(source).not.toContain('orderDetailSpreadsheetColumnLabel');
    expect(source).not.toContain('order-detail-spreadsheet-header__letter');
    expect(appStyles).not.toContain('.order-detail-spreadsheet-header__letter');
    expect(appStyles).toContain('border-spacing: 0 !important');
  });

  it('keeps one-line spreadsheet rows compact and grows only for wrapped content', () => {
    const rowCellStyleStart = appStyles.indexOf(
      '.order-details-table .ant-table-tbody > tr > td {',
    );
    const rowCellStyleEnd = appStyles.indexOf(
      '.order-details-table .ant-table-tbody > tr > td.order-detail-spreadsheet-cell {',
      rowCellStyleStart,
    );
    const rowCellStyles = appStyles.slice(rowCellStyleStart, rowCellStyleEnd);
    const cellStyleStart = appStyles.indexOf(
      '.order-details-table .ant-table-tbody > tr > td.order-detail-spreadsheet-cell {',
    );
    const cellStyleEnd = appStyles.indexOf(
      '.order-details-table .ant-table-tbody > tr > td.order-detail-spreadsheet-cell[data-order-detail-column-key="detail_number"]',
      cellStyleStart,
    );
    const cellStyles = appStyles.slice(cellStyleStart, cellStyleEnd);

    expect(rowCellStyles).toContain('height: 20px');
    expect(rowCellStyles).toContain('padding: 0 4px !important');
    expect(rowCellStyles).toContain('vertical-align: middle');
    expect(cellStyles).toContain('height: 20px');
    expect(cellStyles).toContain('padding: 0 2px !important');
    expect(cellStyles).toContain('line-height: 18px');
    expect(cellStyles).toContain('white-space: normal');
    expect(cellStyles).toContain('overflow-wrap: anywhere');
    expect(cellStyles).not.toContain('white-space: nowrap');
    expect(appStyles).not.toContain(
      '@media (pointer: coarse) {\n  .order-details-table .ant-table-tbody > tr > td.order-detail-spreadsheet-cell',
    );
    expect(appStyles).toContain(
      '.order-details-table .ant-table-tbody > tr > td .ant-btn-sm',
    );
    expect(appStyles).toContain('box-sizing: border-box');
    expect(appStyles).toContain('padding: 0 !important;\n}\n\n.order-details-table td.order-detail-spreadsheet-cell .ant-input,');
    expect(appStyles).toContain('padding: 2px !important;');
    expect(appStyles).toContain('padding-inline: 2px !important;');
  });

  it('commits the latest price value and recalculates the sum on blur', () => {
    expect(source).toContain('const handleMillingCostBlur = useCallback(() => {');
    expect(source).toContain("form.getFieldValue('milling_cost_per_sqm')");
    expect(source).toContain("recalcSum('milling_cost_per_sqm', value)");
    expect(source).toContain('onBlur={handleMillingCostBlur}');
  });

  it('uses arrow keys for cell selection instead of changing editor values', () => {
    expect(source).toContain('const editorDirectionByKey: Partial<Record<string, OrderDetailSpreadsheetDirection>>');
    expect(source).toContain('const editorDirection = editorDirectionByKey[event.key]');
    expect(source).toContain("moveOrderDetailSpreadsheetCell(\n        getSpreadsheetNavigationRowKeys(),");
    expect(source).toContain('if (saved) focusSpreadsheetCoordinate(nextCell)');
    expect(source.match(/keyboard=\{false\}/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(source).toContain('event.key.length !== 1');
    expect(source).toContain('void beginSpreadsheetCellEdit(record, columnKey, initialValue);');
  });

  it('keeps only the spreadsheet cell frame around an active editor', () => {
    expect(appStyles).toContain(
      'td.order-detail-spreadsheet-cell .ant-input-number-input:focus',
    );
    expect(appStyles).toContain(
      'td.order-detail-spreadsheet-cell .ant-select-focused .ant-select-selector',
    );
    expect(appStyles).toContain('outline: none !important');
    expect(appStyles).toContain('box-shadow: none !important');
  });

  it('frames only the active cell without replacing the row background', () => {
    const styleStart = appStyles.indexOf(
      '.order-details-table .ant-table-tbody > tr > td.order-detail-spreadsheet-cell:focus,',
    );
    const styleEnd = appStyles.indexOf(
      '.order-details-table td.order-detail-spreadsheet-cell .ant-form-item',
      styleStart,
    );
    const activeCellStyles = appStyles.slice(styleStart, styleEnd);

    expect(activeCellStyles).toContain('var(--order-detail-grid-accent)');
    expect(activeCellStyles).not.toContain('background-color');
    expect(appStyles).not.toContain('td.order-detail-spreadsheet-cell:focus::after');
    expect(appStyles).not.toContain('tr.order-detail-row-editing > td');
    expect(appStyles).not.toContain('tr.dg-editing > td { background-color: var(--app-highlight)');
  });

  it('uses CSS row hover without rc-table cell hover mutations', () => {
    expect(source).toContain('const OrderDetailBodyCell = React.forwardRef');
    expect(source).toContain('onMouseEnter: _onMouseEnter');
    expect(source).toContain('onMouseLeave: _onMouseLeave');
    expect(source).toContain('components={ORDER_DETAIL_TABLE_COMPONENTS}');
    expect(source).not.toContain('dragSelection.handleMouseEnter');
  });

  it('isolates edit-table scrolling from rc-table ping updates', () => {
    expect(source).toContain('<TableTopScroll');
    expect(source).toContain('manageAntTableScroll');
  });

  it('lets rc-table finish its initial measurement before mounting detail rows', () => {
    expect(source).toContain('const [tableRowsReady, setTableRowsReady] = useState(false);');
    expect(source).toContain('window.requestAnimationFrame(() => {');
    expect(source).toContain('window.setTimeout(() => setTableRowsReady(true), 0);');
    expect(source).toContain('dataSource={mountedTableRows as any}');
    expect(source).toContain("className={tableRowsReady ? undefined : 'order-details-table-scroll-shell--initializing'}");
    expect(source).toContain('loading={!tableRowsReady}');
  });

  it('preserves intentional null results from cell renderers', () => {
    expect(source).toContain('const renderer = runtime?.renderByKey.get(columnKey);');
    expect(source).toContain('renderer ? renderer(value, row, index) : value');
    expect(source).not.toContain('?.(value, row, index) ?? value');
  });
});
