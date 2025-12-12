// Step 2: Visual range selection with larger scrollable area

import React, { useCallback, useRef, useMemo } from 'react';
import { Typography, Checkbox, Space, Tag, Button, Tooltip } from 'antd';
import { DeleteOutlined, ClearOutlined } from '@ant-design/icons';
import type { ParsedSheet, SelectionRange, NormalizedRange } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

const { Text, Title } = Typography;

interface RangeSelectionStepProps {
  sheetData: ParsedSheet;
  ranges: SelectionRange[];
  activeRangeId: string | null;
  isSelecting: boolean;
  currentSelection: SelectionRange | null;
  hasHeaders: boolean;
  onHasHeadersChange: (value: boolean) => void;
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

export const RangeSelectionStep: React.FC<RangeSelectionStepProps> = ({
  sheetData,
  ranges,
  activeRangeId,
  isSelecting,
  currentSelection,
  hasHeaders,
  onHasHeadersChange,
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

  // Memoize grid cells for performance
  const gridCells = useMemo(() => {
    const cells: React.ReactNode[] = [];

    // Header row (column letters)
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

    for (let col = 0; col < visibleCols; col++) {
      cells.push(
        <div
          key={`header-${col}`}
          className="excel-cell excel-header-cell"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            backgroundColor: '#fafafa',
            borderBottom: '1px solid #d9d9d9',
            fontWeight: 600,
          }}
        >
          {getColumnLetter(col)}
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
  }, [sheetData.data, visibleRows, visibleCols, getCellRange, handleMouseDown, handleMouseMove, handleMouseUp]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        .excel-grid-container {
          flex: 1;
          overflow: auto;
          border: 1px solid #d9d9d9;
          border-radius: 4px;
          user-select: none;
          min-height: 400px;
          max-height: calc(80vh - 200px);
        }
        .excel-grid {
          display: grid;
          grid-template-columns: 40px repeat(${visibleCols}, minmax(80px, 120px));
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
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

      <Space direction="vertical" style={{ marginBottom: 12 }} size="small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={5} style={{ margin: 0 }}>
            Выделите область данных мышью
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

        {ranges.length > 0 && (
          <div>
            <Text type="secondary" style={{ marginRight: 8 }}>Выделенные области:</Text>
            {ranges.map((range) => (
              <Tag
                key={range.id}
                color={activeRangeId === range.id ? 'blue' : 'default'}
                style={{
                  marginBottom: 4,
                  backgroundColor: range.color,
                  cursor: 'pointer',
                }}
                closable
                onClose={() => onRemoveRange(range.id)}
                onClick={() => onSetActiveRange(range.id)}
              >
                {formatRange(range)}
              </Tag>
            ))}
          </div>
        )}

        <Text type="secondary" style={{ fontSize: 12 }}>
          Зажмите левую кнопку мыши и выделите область. Можно выделить несколько областей.
          {sheetData.rowCount > MAX_VISIBLE_ROWS && ` Показаны первые ${MAX_VISIBLE_ROWS} строк.`}
          {sheetData.colCount > MAX_VISIBLE_COLS && ` Показаны первые ${MAX_VISIBLE_COLS} колонок.`}
        </Text>
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
