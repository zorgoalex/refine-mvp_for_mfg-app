// Step 2: Range Selection - Visual selection of data areas

import React, { useCallback, useRef } from 'react';
import { Card, Space, Typography, Switch, Button, Tag, Alert, Tooltip } from 'antd';
import { DeleteOutlined, PlusOutlined, ClearOutlined } from '@ant-design/icons';
import type { ParsedSheet, CellValue } from '../types/importTypes';
import type { UseRangeSelectionReturn } from '../hooks/useRangeSelection';
import { getColumnLetter } from '../types/importTypes';

const { Text } = Typography;

interface RangeSelectionStepProps {
  sheetData: ParsedSheet | null;
  selection: UseRangeSelectionReturn;
  hasHeaderRow: boolean;
  onHasHeaderRowChange: (value: boolean) => void;
}

// Maximum rows/cols to display for performance
const MAX_DISPLAY_ROWS = 100;
const MAX_DISPLAY_COLS = 20;

export const RangeSelectionStep: React.FC<RangeSelectionStepProps> = ({
  sheetData,
  selection,
  hasHeaderRow,
  onHasHeaderRowChange,
}) => {
  const gridRef = useRef<HTMLDivElement>(null);

  const {
    ranges,
    isSelecting,
    currentSelection,
    startSelection,
    updateSelection,
    endSelection,
    removeRange,
    clearRanges,
    normalizeRange,
    getRangeForCell,
  } = selection;

  // Format cell value for display
  const formatCellValue = (value: CellValue): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      // Format numbers nicely
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return value.toLocaleDateString();
    const str = String(value);
    return str.length > 15 ? str.substring(0, 15) + '...' : str;
  };

  // Get range display string (e.g., "A1:D10")
  const getRangeString = (range: { startRow: number; endRow: number; startCol: number; endCol: number }): string => {
    const norm = normalizeRange(range as any);
    const startCell = `${getColumnLetter(norm.minCol)}${norm.minRow + 1}`;
    const endCell = `${getColumnLetter(norm.maxCol)}${norm.maxRow + 1}`;
    return `${startCell}:${endCell}`;
  };

  // Handle mouse events for selection
  const handleMouseDown = useCallback((row: number, col: number) => {
    startSelection(row, col);
  }, [startSelection]);

  const handleMouseMove = useCallback((row: number, col: number) => {
    if (isSelecting) {
      updateSelection(row, col);
    }
  }, [isSelecting, updateSelection]);

  const handleMouseUp = useCallback(() => {
    if (isSelecting) {
      endSelection();
    }
  }, [isSelecting, endSelection]);

  // Get cell style based on selection state
  const getCellStyle = (row: number, col: number): React.CSSProperties => {
    const range = getRangeForCell(row, col);

    const baseStyle: React.CSSProperties = {
      padding: '2px 4px',
      border: '1px solid #e8e8e8',
      fontSize: 11,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: 80,
      minWidth: 40,
      cursor: 'crosshair',
      userSelect: 'none',
    };

    if (range) {
      return {
        ...baseStyle,
        backgroundColor: range.color || 'rgba(24, 144, 255, 0.2)',
        borderColor: '#1890ff',
      };
    }

    // Highlight header row differently
    if (hasHeaderRow && row === 0 && ranges.length === 0) {
      return {
        ...baseStyle,
        backgroundColor: '#fafafa',
        fontWeight: 'bold',
      };
    }

    return baseStyle;
  };

  if (!sheetData) {
    return <Alert type="warning" message="Сначала загрузите файл" />;
  }

  const displayRows = Math.min(sheetData.rowCount, MAX_DISPLAY_ROWS);
  const displayCols = Math.min(sheetData.colCount, MAX_DISPLAY_COLS);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Instructions */}
      <Alert
        type="info"
        message="Выделите область с данными"
        description="Зажмите левую кнопку мыши и выделите область с данными для импорта. Можно выделить несколько областей."
        showIcon
      />

      {/* Controls */}
      <Card size="small">
        <Space wrap>
          <Space>
            <Text>Первая строка — заголовки:</Text>
            <Switch
              checked={hasHeaderRow}
              onChange={onHasHeaderRowChange}
              checkedChildren="Да"
              unCheckedChildren="Нет"
            />
          </Space>

          <Button
            icon={<ClearOutlined />}
            onClick={clearRanges}
            disabled={ranges.length === 0}
            size="small"
          >
            Сбросить выделение
          </Button>
        </Space>
      </Card>

      {/* Selected ranges */}
      {ranges.length > 0 && (
        <Card size="small" title="Выбранные области">
          <Space wrap>
            {ranges.map((range, index) => (
              <Tag
                key={range.id}
                closable
                onClose={() => removeRange(range.id)}
                color="blue"
              >
                Область {index + 1}: {getRangeString(range)}
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      {/* Excel Grid */}
      <Card
        size="small"
        bodyStyle={{ padding: 0, overflow: 'auto', maxHeight: 400 }}
      >
        <div
          ref={gridRef}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ display: 'inline-block', minWidth: '100%' }}
        >
          <table
            style={{
              borderCollapse: 'collapse',
              fontSize: 11,
            }}
          >
            {/* Column headers */}
            <thead>
              <tr>
                <th style={{
                  padding: '2px 4px',
                  backgroundColor: '#fafafa',
                  border: '1px solid #e8e8e8',
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  zIndex: 2,
                  minWidth: 30,
                }}>
                  #
                </th>
                {Array.from({ length: displayCols }).map((_, colIndex) => (
                  <th
                    key={colIndex}
                    style={{
                      padding: '2px 4px',
                      backgroundColor: '#fafafa',
                      border: '1px solid #e8e8e8',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      minWidth: 40,
                    }}
                  >
                    {getColumnLetter(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>

            {/* Data rows */}
            <tbody>
              {Array.from({ length: displayRows }).map((_, rowIndex) => (
                <tr key={rowIndex}>
                  {/* Row number */}
                  <td style={{
                    padding: '2px 4px',
                    backgroundColor: '#fafafa',
                    border: '1px solid #e8e8e8',
                    textAlign: 'center',
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                  }}>
                    {rowIndex + 1}
                  </td>

                  {/* Data cells */}
                  {Array.from({ length: displayCols }).map((_, colIndex) => {
                    const cellValue = sheetData.data[rowIndex]?.[colIndex];
                    return (
                      <td
                        key={colIndex}
                        style={getCellStyle(rowIndex, colIndex)}
                        onMouseDown={() => handleMouseDown(rowIndex, colIndex)}
                        onMouseMove={() => handleMouseMove(rowIndex, colIndex)}
                        title={formatCellValue(cellValue)}
                      >
                        {formatCellValue(cellValue)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Truncation warning */}
      {(sheetData.rowCount > MAX_DISPLAY_ROWS || sheetData.colCount > MAX_DISPLAY_COLS) && (
        <Text type="secondary">
          Показано {displayRows} из {sheetData.rowCount} строк, {displayCols} из {sheetData.colCount} колонок
        </Text>
      )}
    </Space>
  );
};
