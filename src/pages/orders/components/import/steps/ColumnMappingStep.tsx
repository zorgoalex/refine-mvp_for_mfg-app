// Step 3: Column mapping with visible data preview

import React, { useMemo, useEffect } from 'react';
import { Select, Typography, Row, Col, Card, Table, Tag, Space, Alert } from 'antd';
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import type { ParsedSheet, SelectionRange, FieldMapping, ImportableField, NormalizedRange } from '../types/importTypes';
import { FIELD_CONFIGS, getColumnLetter } from '../types/importTypes';

const { Text, Title } = Typography;

interface ColumnMappingStepProps {
  sheetData: ParsedSheet;
  ranges: SelectionRange[];
  hasHeaders: boolean;
  mapping: FieldMapping;
  onMappingChange: (field: ImportableField, column: string | null) => void;
  onAutoDetect: () => void;
}

const normalizeRange = (range: SelectionRange): NormalizedRange => ({
  minRow: Math.min(range.startRow, range.endRow),
  maxRow: Math.max(range.startRow, range.endRow),
  minCol: Math.min(range.startCol, range.endCol),
  maxCol: Math.max(range.startCol, range.endCol),
});

const PREVIEW_ROWS = 8;

export const ColumnMappingStep: React.FC<ColumnMappingStepProps> = ({
  sheetData,
  ranges,
  hasHeaders,
  mapping,
  onMappingChange,
  onAutoDetect,
}) => {
  // Get columns from first selected range
  const { columns, previewData, headerRow } = useMemo(() => {
    if (ranges.length === 0) return { columns: [], previewData: [], headerRow: null };

    const range = ranges[0];
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);

    const cols: { letter: string; index: number }[] = [];
    for (let c = minCol; c <= maxCol; c++) {
      cols.push({ letter: getColumnLetter(c), index: c });
    }

    const dataStartRow = hasHeaders ? minRow + 1 : minRow;
    const data: Record<string, unknown>[] = [];

    for (let r = dataStartRow; r <= Math.min(maxRow, dataStartRow + PREVIEW_ROWS - 1); r++) {
      const row = sheetData.data[r];
      if (!row) continue;
      const rowData: Record<string, unknown> = { key: r };
      for (let c = minCol; c <= maxCol; c++) {
        rowData[getColumnLetter(c)] = row[c];
      }
      data.push(rowData);
    }

    const header = hasHeaders ? sheetData.data[minRow] : null;

    return { columns: cols, previewData: data, headerRow: header };
  }, [ranges, sheetData.data, hasHeaders]);

  // Run auto-detect on mount
  useEffect(() => {
    if (columns.length > 0) {
      onAutoDetect();
    }
  }, []);

  // Get sample values for a column
  const getColumnSamples = (colLetter: string): string[] => {
    const samples: string[] = [];
    for (const row of previewData.slice(0, 3)) {
      const val = row[colLetter];
      if (val != null) samples.push(String(val));
    }
    return samples;
  };

  // Column options for select
  const columnOptions = [
    { label: '— Не выбрано —', value: '' },
    ...columns.map(col => {
      const headerValue = headerRow ? headerRow[col.index] : null;
      const label = headerValue ? `${col.letter} (${headerValue})` : col.letter;
      return { label, value: col.letter };
    }),
  ];

  // Required fields check
  const requiredFields = FIELD_CONFIGS.filter(f => f.required);
  const missingRequired = requiredFields.filter(f => !mapping[f.field]);

  // Table columns for data preview
  const tableColumns = columns.map(col => {
    const headerValue = headerRow ? headerRow[col.index] : null;
    // Find which field this column is mapped to
    const mappedField = Object.entries(mapping).find(([_, v]) => v === col.letter)?.[0] as ImportableField | undefined;
    const fieldConfig = mappedField ? FIELD_CONFIGS.find(f => f.field === mappedField) : null;

    return {
      title: (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 600 }}>{col.letter}</div>
          {headerValue && <div style={{ fontSize: 11, color: '#666' }}>{String(headerValue)}</div>}
          {fieldConfig && (
            <Tag color="blue" style={{ marginTop: 4, fontSize: 10 }}>
              {fieldConfig.label}
            </Tag>
          )}
        </div>
      ),
      dataIndex: col.letter,
      key: col.letter,
      width: 100,
      ellipsis: true,
      render: (value: unknown) => (
        <Text style={{ fontSize: 12 }} ellipsis>
          {value != null ? String(value) : ''}
        </Text>
      ),
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {ranges.length === 0 ? (
        <Alert
          type="warning"
          message="Выберите область данных на предыдущем шаге"
          showIcon
        />
      ) : (
        <>
          {/* Data preview at top */}
          <div style={{ marginBottom: 16 }}>
            <Title level={5} style={{ marginBottom: 8 }}>
              Данные из выделенной области:
            </Title>
            <div style={{ maxHeight: 250, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 4 }}>
              <Table
                columns={tableColumns}
                dataSource={previewData}
                pagination={false}
                size="small"
                scroll={{ x: 'max-content' }}
                bordered
              />
            </div>
          </div>

          {/* Mapping controls */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Title level={5} style={{ margin: 0 }}>
                  Сопоставьте колонки с полями:
                </Title>
                {missingRequired.length > 0 && (
                  <Text type="danger">
                    <WarningOutlined /> Не выбраны: {missingRequired.map(f => f.label).join(', ')}
                  </Text>
                )}
              </div>

              <Row gutter={[16, 12]}>
                {FIELD_CONFIGS.map(config => {
                  const selectedCol = mapping[config.field];
                  const samples = selectedCol ? getColumnSamples(selectedCol) : [];

                  return (
                    <Col xs={24} sm={12} md={8} key={config.field}>
                      <Card
                        size="small"
                        style={{
                          borderColor: config.required && !selectedCol ? '#ff4d4f' : undefined,
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>
                          <Text strong>
                            {config.label}
                            {config.required && <Text type="danger"> *</Text>}
                          </Text>
                          {selectedCol && (
                            <CheckCircleOutlined style={{ color: '#52c41a', marginLeft: 8 }} />
                          )}
                        </div>

                        <Select
                          value={selectedCol || ''}
                          onChange={(val) => onMappingChange(config.field, val || null)}
                          options={columnOptions}
                          style={{ width: '100%' }}
                          size="small"
                          allowClear
                          placeholder="Выберите колонку"
                        />

                        {samples.length > 0 && (
                          <div style={{ marginTop: 6, fontSize: 11, color: '#666' }}>
                            <Text type="secondary">Примеры: </Text>
                            {samples.slice(0, 2).map((s, i) => (
                              <Tag key={i} style={{ fontSize: 10, marginRight: 4 }}>
                                {s.length > 15 ? s.slice(0, 15) + '...' : s}
                              </Tag>
                            ))}
                          </div>
                        )}
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            </Space>
          </div>
        </>
      )}
    </div>
  );
};
