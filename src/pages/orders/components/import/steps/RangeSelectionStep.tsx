// Step 2: Visual range selection with column mapping in headers

import React, { useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { Typography, Checkbox, Space, Tag, Button, Select } from 'antd';
import { ClearOutlined } from '@ant-design/icons';
import type { ParsedSheet, SelectionRange, NormalizedRange, FieldMapping, ImportableField } from '../types/importTypes';
import { getColumnLetter, FIELD_CONFIGS } from '../types/importTypes';
import { getColumnWidths, getGridCell, getEdgeVelocity, getScrollFrameScale, ROW_HEIGHT, HEADER_HEIGHT } from './excelGridGeometry';

const { Text, Title } = Typography;

interface RangeSelectionStepProps {
  sheetData: ParsedSheet;
  sheets: string[];
  selectedSheet: string | null;
  onSheetSelect: (name: string) => void;
  ranges: SelectionRange[];
  activeRangeId: string | null;
  isSelecting: boolean;
  currentSelection: SelectionRange | null;
  hasHeaders: boolean;
  mapping: FieldMapping;
  onHasHeadersChange: (value: boolean) => void;
  onMappingChange: (field: ImportableField, column: string | null) => void;
  onStartSelection: (row: number, col: number, moveId?: string) => void;
  onUpdateSelection: (row: number, col: number) => void;
  onEndSelection: () => void;
  onCancelSelection: () => void;
  recognitionNotice?: string;
  onRemoveRange: (id: string) => void;
  onClearRanges: () => void;
  onSetActiveRange: (id: string | null) => void;
}

const normalizeRange = (range: SelectionRange): NormalizedRange => ({
  minRow: Math.min(range.startRow, range.endRow),
  maxRow: Math.max(range.startRow, range.endRow),
  minCol: Math.min(range.startCol, range.endCol),
  maxCol: Math.max(range.startCol, range.endCol),
});

// Short labels for mapping dropdown
const FIELD_OPTIONS = [
  { value: '', label: '—' },
  { value: 'height', label: 'Высота' },
  { value: 'width', label: 'Ширина' },
  { value: 'quantity', label: 'Кол-во' },
  { value: 'edge_type', label: 'Обкат' },
  { value: 'material', label: 'Материал' },
  { value: 'milling_type', label: 'Фрезер.' },
  { value: 'film', label: 'Плёнка' },
  { value: 'note', label: 'Примеч.' },
  { value: 'detail_name', label: 'Назв.' },
];

export const RangeSelectionStep: React.FC<RangeSelectionStepProps> = ({
  sheetData,
  sheets,
  selectedSheet,
  onSheetSelect,
  ranges,
  activeRangeId,
  isSelecting,
  currentSelection,
  hasHeaders,
  mapping,
  onHasHeadersChange,
  onMappingChange,
  onStartSelection,
  onUpdateSelection,
  onEndSelection,
  onCancelSelection,
  recognitionNotice,
  onRemoveRange,
  onClearRanges,
  onSetActiveRange,
}) => {
  const tableRef = useRef<HTMLDivElement>(null);

  const visibleCols = sheetData.colCount;
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const firstRow = Math.max(0, Math.floor((viewport.top - HEADER_HEIGHT) / ROW_HEIGHT) - 8);
  const lastRow = Math.min(sheetData.rowCount, firstRow + Math.ceil(viewport.height / ROW_HEIGHT) + 18);

  // Get selected columns from first range
  const selectedCols = useMemo(() => {
    const cols = new Set<number>();
    for (const range of ranges) {
      const { minCol, maxCol } = normalizeRange(range);
      for (let c = minCol; c <= maxCol; c++) cols.add(c);
    }
    return cols;
  }, [ranges]);

  const columnWidths = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d');
    if (context) context.font = '12px Consolas, Monaco, monospace';
    return getColumnWidths(sheetData, text => context?.measureText(text).width ?? text.length * 7.2, selectedCols);
  }, [sheetData, selectedCols]);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const animation = useRef<number | null>(null);
  const previousFrame = useRef<number | null>(null);
  const callbacks = useRef({ onUpdateSelection, onEndSelection, onCancelSelection });
  callbacks.current = { onUpdateSelection, onEndSelection, onCancelSelection };

  const finishSelection = useCallback((commit: boolean) => {
    const pointer = drag.current;
    if (!pointer) return;
    drag.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    previousFrame.current = null;
    const table = tableRef.current;
    if (table?.hasPointerCapture(pointer.pointerId)) table.releasePointerCapture(pointer.pointerId);
    if (commit) callbacks.current.onEndSelection();
    else callbacks.current.onCancelSelection();
  }, []);

  const updatePointerCell = useCallback(() => {
    const table = tableRef.current;
    const pointer = drag.current;
    if (!table || !pointer) return;
    const bounds = table.getBoundingClientRect();
    const x = Math.max(bounds.left + 40, Math.min(pointer.x, bounds.left + table.clientWidth - 1));
    const y = Math.max(bounds.top + HEADER_HEIGHT, Math.min(pointer.y, bounds.top + table.clientHeight - 1));
    const cell = getGridCell(columnWidths, sheetData.rowCount,
      x - bounds.left + table.scrollLeft, y - bounds.top + table.scrollTop);
    callbacks.current.onUpdateSelection(cell.row, cell.col);
  }, [columnWidths, sheetData.rowCount]);

  const scrollSelection = useCallback(function tick(timestamp: number) {
    const table = tableRef.current;
    const pointer = drag.current;
    if (!table || !pointer) return;
    const frameScale = getScrollFrameScale(timestamp, previousFrame.current);
    previousFrame.current = timestamp;
    const bounds = table.getBoundingClientRect();
    table.scrollLeft += getEdgeVelocity(pointer.x, bounds.left + 40, bounds.left + table.clientWidth) * frameScale;
    table.scrollTop += getEdgeVelocity(pointer.y, bounds.top + HEADER_HEIGHT, bounds.top + table.clientHeight) * frameScale;
    updatePointerCell();
    animation.current = requestAnimationFrame(tick);
  }, [updatePointerCell]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    table.scrollTop = 0;
    table.scrollLeft = 0;
    const observe = () => setViewport({ top: table.scrollTop, height: table.clientHeight });
    const observer = new ResizeObserver(observe);
    observer.observe(table);
    observe();
    const cancel = () => finishSelection(false);
    window.addEventListener('blur', cancel);
    return () => { observer.disconnect(); window.removeEventListener('blur', cancel); cancel(); };
  }, [sheetData, finishSelection]);

  // Get which field is mapped to which column
  const getFieldForColumn = useCallback((colLetter: string): ImportableField | null => {
    for (const [field, col] of Object.entries(mapping)) {
      if (col === colLetter) return field as ImportableField;
    }
    return null;
  }, [mapping]);

  // Handle mapping change from header dropdown
  const handleHeaderMappingChange = useCallback((colLetter: string, field: string) => {
    // First, clear any existing mapping to this column
    for (const [existingField, col] of Object.entries(mapping)) {
      if (col === colLetter) {
        onMappingChange(existingField as ImportableField, null);
      }
    }
    // Then set new mapping
    if (field) {
      // Clear previous column for this field
      onMappingChange(field as ImportableField, colLetter);
    }
  }, [mapping, onMappingChange]);

  // Check if cell is in any range
  const getCellRange = useCallback((row: number, col: number): SelectionRange | null => {
    if (currentSelection) {
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(currentSelection);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return currentSelection;
      }
    }
    for (const range of ranges) {
      if (range.id === currentSelection?.id) continue;
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return range;
      }
    }
    return null;
  }, [ranges, currentSelection]);

  const handlePointerDown = useCallback((row: number, col: number, e: React.PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || !tableRef.current) return;
    e.preventDefault();
    const existing = getCellRange(row, col);
    onStartSelection(row, col, !e.shiftKey && existing?.id === activeRangeId ? existing.id : undefined);
    drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    previousFrame.current = null;
    tableRef.current.setPointerCapture(e.pointerId);
    animation.current = requestAnimationFrame(scrollSelection);
  }, [onStartSelection, getCellRange, activeRangeId, scrollSelection]);

  // Format range as A1:B10
  const formatRange = (range: SelectionRange): string => {
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
    return `${getColumnLetter(minCol)}${minRow + 1}:${getColumnLetter(maxCol)}${maxRow + 1}`;
  };

  // Check required fields
  const missingRequired = useMemo(() => {
    const required = FIELD_CONFIGS.filter(f => f.required);
    return required.filter(f => !mapping[f.field]).map(f => f.label);
  }, [mapping]);

  // Memoize grid cells for performance
  const gridCells = useMemo(() => {
    const cells: React.ReactNode[] = [];

    // Corner cell
    cells.push(
      <div key="corner" className="excel-cell excel-header-cell corner" style={{
        height: HEADER_HEIGHT,
        position: 'sticky',
        left: 0,
        top: 0,
        zIndex: 3,
        backgroundColor: 'var(--app-surface-muted)',
        borderRight: '1px solid var(--app-border)',
        borderBottom: '1px solid var(--app-border)',
      }} />
    );

    // Header row with mapping dropdowns
    for (let col = 0; col < visibleCols; col++) {
      const colLetter = getColumnLetter(col);
      const isInSelectedRange = selectedCols.has(col);
      const mappedField = getFieldForColumn(colLetter);

      cells.push(
        <div
          key={`header-${col}`}
          className="excel-cell excel-header-cell"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            backgroundColor: isInSelectedRange ? 'var(--app-selection-bg)' : 'var(--app-surface-muted)',
            borderBottom: '1px solid var(--app-border)',
            flexDirection: 'column',
            padding: '2px 4px',
            height: HEADER_HEIGHT,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 11 }}>{colLetter}</div>
          {isInSelectedRange && (
            <Select
              size="small"
              value={mappedField || ''}
              onChange={(val) => handleHeaderMappingChange(colLetter, val)}
              options={FIELD_OPTIONS}
              style={{ width: '100%', fontSize: 10 }}
              dropdownStyle={{ minWidth: 100 }}
              aria-label={`Поле колонки ${colLetter}`}
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      );
    }

    // Data rows
    if (firstRow > 0) cells.push(<div key="before" style={{ gridColumn: '1 / -1', height: firstRow * ROW_HEIGHT }} />);
    for (let row = firstRow; row < lastRow; row++) {
      // Row number cell
      cells.push(
        <div
          key={`row-${row}`}
          className="excel-cell excel-row-number"
          style={{
            position: 'sticky',
            left: 0,
            zIndex: 2,
            backgroundColor: 'var(--app-surface-muted)',
            borderRight: '1px solid var(--app-border)',
            fontWeight: 600,
          }}
        >
          {row + 1}
        </div>
      );

      // Data cells
      for (let col = 0; col < visibleCols; col++) {
        const cellValue = sheetData.data[row]?.[col];
        const range = getCellRange(row, col);
        const isSelected = !!range;

        cells.push(
          <div
            key={`${row}-${col}`}
            className={`excel-cell ${isSelected ? 'selected' : ''}`}
            data-row={row}
            data-col={col}
            title={cellValue == null ? '' : String(cellValue)}
            style={{
              backgroundColor: isSelected ? range?.color : undefined,
              cursor: isSelected && range?.id === activeRangeId ? 'move' : 'cell',
            }}
            onPointerDown={(e) => handlePointerDown(row, col, e)}
          >
            <span className="cell-content">
              {cellValue != null ? String(cellValue) : ''}
            </span>
          </div>
        );
      }
    }

    if (lastRow < sheetData.rowCount) cells.push(<div key="after" style={{ gridColumn: '1 / -1', height: (sheetData.rowCount - lastRow) * ROW_HEIGHT }} />);
    return cells;
  }, [sheetData.data, sheetData.rowCount, firstRow, lastRow, visibleCols, selectedCols, getFieldForColumn, getCellRange, handlePointerDown, handleHeaderMappingChange, activeRangeId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <style>{`
        .excel-grid-container {
          overflow: auto;
          border: 1px solid var(--app-border);
          border-radius: 4px;
          user-select: none;
          flex: 1;
          min-height: 160px;
          min-width: 0;
          touch-action: none;
          overscroll-behavior: contain;
        }
        .excel-grid {
          display: grid;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          width: max-content;
        }
        .excel-cell {
          padding: 4px 6px;
          border-right: 1px solid var(--app-border-soft);
          border-bottom: 1px solid var(--app-border-soft);
          height: ${ROW_HEIGHT}px;
          box-sizing: border-box;
          min-width: 0;
          display: flex;
          align-items: center;
          white-space: nowrap;
          overflow: hidden;
        }
        .excel-cell.selected {
          border: 1px solid rgba(24, 144, 255, 0.5);
        }
        .excel-header-cell {
          justify-content: center;
          color: #666;
          font-size: 11px;
        }
        .excel-row-number {
          justify-content: center;
          color: #666;
          font-size: 11px;
          min-width: 40px;
        }
        .cell-content {
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        .corner {
          min-width: 40px;
        }
      `}</style>

      <Space direction="vertical" style={{ marginBottom: 8 }} size="small">
        {recognitionNotice && <Text type="secondary" data-testid="excel-export-recognized">{recognitionNotice}</Text>}
        <Text type="secondary" style={{ fontSize: 12 }}>
          Тяните ЛКМ к краю для прокрутки. Внутри активной области — перенос; Shift — новое выделение. Отпустите ЛКМ для завершения.
        </Text>
        {/* Sheet selector */}
        {sheets.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text>Лист:</Text>
            <Select
              value={selectedSheet}
              onChange={onSheetSelect}
              style={{ minWidth: 200 }}
              options={sheets.map(name => ({ label: name, value: name }))}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({sheetData.rowCount} строк × {sheetData.colCount} столбцов)
            </Text>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Text strong>Выделите область и укажите поля в заголовках</Text>
          <Space>
            <Checkbox
              checked={hasHeaders}
              onChange={(e) => onHasHeadersChange(e.target.checked)}
            >
              Первая строка — заголовки
            </Checkbox>
            {ranges.length > 0 && (
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={onClearRanges}
              >
                Очистить
              </Button>
            )}
          </Space>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {ranges.length > 0 && (
            <div>
              <Text type="secondary" style={{ marginRight: 8 }}>Область:</Text>
              {ranges.map((range) => (
                <Tag
                  key={range.id}
                  color={activeRangeId === range.id ? 'blue' : 'default'}
                  style={{ marginBottom: 4, backgroundColor: range.color, cursor: 'pointer' }}
                  closable
                  onClose={() => onRemoveRange(range.id)}
                  onClick={() => onSetActiveRange(range.id)}
                >
                  {formatRange(range)}
                </Tag>
              ))}
            </div>
          )}
          {missingRequired.length > 0 && ranges.length > 0 && (
            <Text type="danger" style={{ fontSize: 12 }}>
              Не указаны: {missingRequired.join(', ')}
            </Text>
          )}
        </div>
      </Space>

      <div
        ref={tableRef}
        className="excel-grid-container"
        data-testid="excel-range-grid"
        data-selecting={isSelecting}
        onScroll={() => {
          const table = tableRef.current;
          if (table) setViewport({ top: table.scrollTop, height: table.clientHeight });
        }}
        onPointerMove={event => {
          if (!drag.current || event.pointerId !== drag.current.pointerId) return;
          if (!(event.buttons & 1)) { finishSelection(false); return; }
          drag.current.x = event.clientX;
          drag.current.y = event.clientY;
          updatePointerCell();
        }}
        onPointerUp={event => {
          if (event.pointerId !== drag.current?.pointerId || event.button !== 0) return;
          drag.current.x = event.clientX;
          drag.current.y = event.clientY;
          updatePointerCell();
          finishSelection(true);
        }}
        onPointerCancel={() => finishSelection(false)}
        onLostPointerCapture={() => finishSelection(false)}
      >
        <div className="excel-grid" style={{ gridTemplateColumns: `40px ${columnWidths.map(width => `${width}px`).join(' ')}` }}>
          {gridCells}
        </div>
      </div>
    </div>
  );
};
