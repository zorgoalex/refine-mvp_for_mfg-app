// Step 2: Visual range selection with column mapping in headers

import React, { useCallback, useRef, useMemo } from 'react';
import { Typography, Checkbox, Space, Tag, Button, Select } from 'antd';
import { ClearOutlined } from '@ant-design/icons';
import type { ParsedSheet, SelectionRange, NormalizedRange, FieldMapping, ImportableField } from '../types/importTypes';
import { getColumnLetter, FIELD_CONFIGS } from '../types/importTypes';

const { Text, Title } = Typography;

interface RangeSelectionStepProps {
  sheetData: ParsedSheet;
  ranges: SelectionRange[];
  activeRangeId: string | null;
  isSelecting: boolean;
  currentSelection: SelectionRange | null;
  hasHeaders: boolean;
  mapping: FieldMapping;
  onHasHeadersChange: (value: boolean) => void;
  onMappingChange: (field: ImportableField, column: string | null) => void;
  onStartSelection: (row: number, col: number) => void;
  onUpdateSelection: (row: number, col: number) => void;
  onEndSelection: () => void;
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

const MAX_VISIBLE_ROWS = 150;
const MAX_VISIBLE_COLS = 30;

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
  onRemoveRange,
  onClearRanges,
  onSetActiveRange,
}) => {
  const tableRef = useRef<HTMLDivElement>(null);

  const visibleRows = Math.min(sheetData.rowCount, MAX_VISIBLE_ROWS);
  const visibleCols = Math.min(sheetData.colCount, MAX_VISIBLE_COLS);

  // Calculate dynamic height based on actual rows (26px per row + 50px header)
  // Max height is 75vh to fit in modal, min is 200px
  const calculatedHeight = Math.min(
    Math.max(visibleRows * 26 + 60, 200),
    window.innerHeight * 0.75
  );
  const gridHeight = `${Math.round(calculatedHeight)}px`;

  // Get selected columns from first range
  const selectedCols = useMemo(() => {
    if (ranges.length === 0) return new Set<number>();
    const { minCol, maxCol } = normalizeRange(ranges[0]);
    const cols = new Set<number>();
    for (let c = minCol; c <= maxCol; c++) cols.add(c);
    return cols;
  }, [ranges]);

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
      const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
      if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
        return range;
      }
    }
    return null;
  }, [ranges, currentSelection]);

  const handleMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    e.preventDefault();
    onStartSelection(row, col);
  }, [onStartSelection]);

  const handleMouseMove = useCallback((row: number, col: number) => {
    if (isSelecting) {
      onUpdateSelection(row, col);
    }
  }, [isSelecting, onUpdateSelection]);

  const handleMouseUp = useCallback(() => {
    if (isSelecting) {
      onEndSelection();
    }
  }, [isSelecting, onEndSelection]);

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
        position: 'sticky',
        left: 0,
        top: 0,
        zIndex: 3,
        backgroundColor: '#fafafa',
        borderRight: '1px solid #d9d9d9',
        borderBottom: '1px solid #d9d9d9',
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
            backgroundColor: isInSelectedRange ? '#e6f7ff' : '#fafafa',
            borderBottom: '1px solid #d9d9d9',
            flexDirection: 'column',
            padding: '2px 4px',
            minHeight: 50,
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
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      );
    }

    // Data rows
    for (let row = 0; row < visibleRows; row++) {
      // Row number cell
      cells.push(
        <div
          key={`row-${row}`}
          className="excel-cell excel-row-number"
          style={{
            position: 'sticky',
            left: 0,
            zIndex: 2,
            backgroundColor: '#fafafa',
            borderRight: '1px solid #d9d9d9',
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
            style={{
              backgroundColor: isSelected ? range?.color : undefined,
              cursor: 'cell',
            }}
            onMouseDown={(e) => handleMouseDown(row, col, e)}
            onMouseMove={() => handleMouseMove(row, col)}
            onMouseUp={handleMouseUp}
          >
            <span className="cell-content">
              {cellValue != null ? String(cellValue) : ''}
            </span>
          </div>
        );
      }
    }

    return cells;
  }, [sheetData.data, visibleRows, visibleCols, selectedCols, getFieldForColumn, getCellRange, handleMouseDown, handleMouseMove, handleMouseUp, handleHeaderMappingChange]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        .excel-grid-container {
          overflow: auto;
          border: 1px solid #d9d9d9;
          border-radius: 4px;
          user-select: none;
          height: ${gridHeight};
          max-height: 75vh;
          min-height: 200px;
          resize: vertical;
        }
        .excel-grid {
          display: grid;
          grid-template-columns: 40px repeat(${visibleCols}, minmax(80px, 120px));
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
          width: max-content;
        }
        .excel-cell {
          padding: 4px 6px;
          border-right: 1px solid #f0f0f0;
          border-bottom: 1px solid #f0f0f0;
          min-height: 26px;
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Title level={5} style={{ margin: 0 }}>
            Выделите область и укажите поля в заголовках
          </Title>
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
        onMouseLeave={handleMouseUp}
      >
        <div className="excel-grid">
          {gridCells}
        </div>
      </div>
    </div>
  );
};
