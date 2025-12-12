// Step 3: Column Mapping - Map Excel columns to detail fields

import React, { useCallback, useEffect, useMemo } from 'react';
import { Card, Space, Typography, Select, Table, Tag, Alert, Button } from 'antd';
import { ThunderboltOutlined, ClearOutlined } from '@ant-design/icons';
import type { ParsedSheet, FieldMapping, SelectionRange, CellValue, ImportableField } from '../types/importTypes';
import { FIELD_CONFIGS, FIELD_KEYWORDS, getColumnLetter, getColumnIndex } from '../types/importTypes';

const { Text } = Typography;

interface ColumnMappingStepProps {
  sheetData: ParsedSheet | null;
  ranges: SelectionRange[];
  fieldMapping: FieldMapping;
  onFieldMappingChange: (mapping: FieldMapping) => void;
  hasHeaderRow: boolean;
}

export const ColumnMappingStep: React.FC<ColumnMappingStepProps> = ({
  sheetData,
  ranges,
  fieldMapping,
  onFieldMappingChange,
  hasHeaderRow,
}) => {
  // Get columns from selected ranges
  const availableColumns = useMemo(() => {
    if (!sheetData || ranges.length === 0) return [];

    const columns: { letter: string; index: number; header: string; samples: string[] }[] = [];
    const seenCols = new Set<number>();

    for (const range of ranges) {
      const minCol = Math.min(range.startCol, range.endCol);
      const maxCol = Math.max(range.startCol, range.endCol);
      const minRow = Math.min(range.startRow, range.endRow);

      for (let col = minCol; col <= maxCol; col++) {
        if (seenCols.has(col)) continue;
        seenCols.add(col);

        const letter = getColumnLetter(col);

        // Get header (first row if hasHeaderRow)
        const headerValue = hasHeaderRow ? sheetData.data[minRow]?.[col] : null;
        const header = headerValue ? String(headerValue) : letter;

        // Get sample values (next 3 rows after header)
        const sampleStartRow = hasHeaderRow ? minRow + 1 : minRow;
        const samples: string[] = [];
        for (let row = sampleStartRow; row < sampleStartRow + 3 && row < sheetData.rowCount; row++) {
          const val = sheetData.data[row]?.[col];
          if (val !== null && val !== undefined) {
            samples.push(String(val));
          }
        }

        columns.push({ letter, index: col, header, samples });
      }
    }

    return columns.sort((a, b) => a.index - b.index);
  }, [sheetData, ranges, hasHeaderRow]);

  // Auto-detect mapping based on header keywords
  const autoDetectMapping = useCallback(() => {
    if (!sheetData || availableColumns.length === 0) return;

    const newMapping: FieldMapping = {
      height: null,
      width: null,
      quantity: null,
      edge_type: null,
      film: null,
      material: null,
      milling_type: null,
      note: null,
      detail_name: null,
    };

    const usedColumns = new Set<string>();

    // For each field, try to find a matching column
    for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
      for (const col of availableColumns) {
        if (usedColumns.has(col.letter)) continue;

        const headerLower = col.header.toLowerCase();

        // Check if header contains any keyword
        const matches = keywords.some(kw => headerLower.includes(kw.toLowerCase()));

        if (matches) {
          newMapping[field as keyof FieldMapping] = col.letter;
          usedColumns.add(col.letter);
          break;
        }
      }
    }

    onFieldMappingChange(newMapping);
  }, [sheetData, availableColumns, onFieldMappingChange]);

  // Clear mapping
  const clearMapping = useCallback(() => {
    onFieldMappingChange({
      height: null,
      width: null,
      quantity: null,
      edge_type: null,
      film: null,
      material: null,
      milling_type: null,
      note: null,
      detail_name: null,
    });
  }, [onFieldMappingChange]);

  // Handle single field mapping change
  const handleFieldChange = useCallback((field: keyof FieldMapping, value: string | null) => {
    onFieldMappingChange({
      ...fieldMapping,
      [field]: value || null,
    });
  }, [fieldMapping, onFieldMappingChange]);

  // Get column options for select
  const columnOptions = useMemo(() => {
    return [
      { label: '— Не выбрано —', value: '' },
      ...availableColumns.map(col => ({
        label: `${col.letter}: ${col.header}`,
        value: col.letter,
      })),
    ];
  }, [availableColumns]);

  // Get sample values for a column
  const getSamples = (letter: string | null): string => {
    if (!letter) return '—';
    const col = availableColumns.find(c => c.letter === letter);
    if (!col || col.samples.length === 0) return '—';
    return col.samples.join(', ');
  };

  // Table data for mapping
  const tableData = FIELD_CONFIGS.map(config => ({
    key: config.field,
    field: config.field,
    label: config.label,
    required: config.required,
    type: config.type,
    mappedColumn: fieldMapping[config.field as keyof FieldMapping],
    samples: getSamples(fieldMapping[config.field as keyof FieldMapping]),
  }));

  // Table columns
  const tableColumns = [
    {
      title: 'Поле',
      dataIndex: 'label',
      key: 'label',
      width: 150,
      render: (text: string, record: any) => (
        <Space>
          <Text>{text}</Text>
          {record.required && <Tag color="red">*</Tag>}
        </Space>
      ),
    },
    {
      title: 'Колонка Excel',
      dataIndex: 'mappedColumn',
      key: 'mappedColumn',
      width: 200,
      render: (_: any, record: any) => (
        <Select
          value={record.mappedColumn || ''}
          onChange={(value) => handleFieldChange(record.field, value)}
          options={columnOptions}
          style={{ width: '100%' }}
          status={record.required && !record.mappedColumn ? 'warning' : undefined}
        />
      ),
    },
    {
      title: 'Примеры значений',
      dataIndex: 'samples',
      key: 'samples',
      render: (text: string) => (
        <Text type="secondary" ellipsis style={{ maxWidth: 200 }}>
          {text}
        </Text>
      ),
    },
  ];

  if (!sheetData) {
    return <Alert type="warning" message="Сначала загрузите файл" />;
  }

  if (ranges.length === 0) {
    return <Alert type="warning" message="Сначала выделите область данных" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Instructions */}
      <Alert
        type="info"
        message="Сопоставьте колонки"
        description="Укажите, какие колонки Excel соответствуют полям детали. Обязательные поля отмечены звёздочкой."
        showIcon
      />

      {/* Auto-detect button */}
      <Space>
        <Button
          icon={<ThunderboltOutlined />}
          onClick={autoDetectMapping}
        >
          Автоопределение
        </Button>
        <Button
          icon={<ClearOutlined />}
          onClick={clearMapping}
        >
          Сбросить
        </Button>
      </Space>

      {/* Mapping table */}
      <Card size="small">
        <Table
          dataSource={tableData}
          columns={tableColumns}
          pagination={false}
          size="small"
        />
      </Card>

      {/* Status */}
      <Space>
        <Text>
          Обязательных полей: {FIELD_CONFIGS.filter(c => c.required).length}
        </Text>
        <Text type={fieldMapping.height && fieldMapping.width && fieldMapping.quantity ? 'success' : 'danger'}>
          {fieldMapping.height && fieldMapping.width && fieldMapping.quantity
            ? '✓ Все обязательные поля заполнены'
            : '✗ Заполните обязательные поля'
          }
        </Text>
      </Space>
    </Space>
  );
};
