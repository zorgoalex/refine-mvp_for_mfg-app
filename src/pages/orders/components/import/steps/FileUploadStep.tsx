// Step 1: File Upload and Sheet Selection

import React, { useCallback } from 'react';
import { Upload, Select, Card, Typography, Space, Alert, Spin, Table } from 'antd';
import { InboxOutlined, FileExcelOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { UseExcelParserReturn } from '../hooks/useExcelParser';
import type { CellValue } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

const { Dragger } = Upload;
const { Text, Title } = Typography;

interface FileUploadStepProps {
  parser: UseExcelParserReturn;
  onFileSelect: (file: File) => Promise<void>;
  onSheetSelect: (sheetName: string) => void;
}

export const FileUploadStep: React.FC<FileUploadStepProps> = ({
  parser,
  onFileSelect,
  onSheetSelect,
}) => {
  const { sheets, selectedSheet, sheetData, isLoading, error } = parser;

  // Handle file upload
  const handleUpload: UploadProps['beforeUpload'] = useCallback((file) => {
    onFileSelect(file);
    return false; // Prevent auto upload
  }, [onFileSelect]);

  // Format cell value for display
  const formatCellValue = (value: CellValue): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return value.toLocaleDateString();
    return String(value);
  };

  // Build preview columns
  const previewColumns = sheetData?.headers.slice(0, 10).map((header, index) => ({
    title: header,
    dataIndex: `col_${index}`,
    key: `col_${index}`,
    width: 100,
    ellipsis: true,
    render: (value: CellValue) => (
      <Text ellipsis style={{ maxWidth: 90 }}>
        {formatCellValue(value)}
      </Text>
    ),
  })) || [];

  // Build preview data (first 5 rows)
  const previewData = sheetData?.data.slice(0, 5).map((row, rowIndex) => {
    const rowData: Record<string, any> = { key: rowIndex };
    row.slice(0, 10).forEach((cell, colIndex) => {
      rowData[`col_${colIndex}`] = cell;
    });
    return rowData;
  }) || [];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {/* File Upload Area */}
      {!sheetData && (
        <Dragger
          accept=".xlsx,.xls,.xlsm,.xlsb"
          beforeUpload={handleUpload}
          showUploadList={false}
          disabled={isLoading}
        >
          <p className="ant-upload-drag-icon">
            {isLoading ? <Spin size="large" /> : <InboxOutlined />}
          </p>
          <p className="ant-upload-text">
            {isLoading ? 'Загрузка файла...' : 'Нажмите или перетащите Excel-файл'}
          </p>
          <p className="ant-upload-hint">
            Поддерживаемые форматы: .xlsx, .xls, .xlsm, .xlsb (до 10 МБ)
          </p>
        </Dragger>
      )}

      {/* Error display */}
      {error && (
        <Alert
          type="error"
          message="Ошибка"
          description={error}
          showIcon
          closable
        />
      )}

      {/* Sheet selection */}
      {sheets.length > 0 && (
        <Card size="small">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <FileExcelOutlined style={{ color: '#52c41a', fontSize: 20 }} />
              <Text strong>Файл загружен</Text>
            </Space>

            <Space>
              <Text>Лист:</Text>
              <Select
                value={selectedSheet}
                onChange={onSheetSelect}
                style={{ width: 200 }}
                options={sheets.map(name => ({ label: name, value: name }))}
              />
              {sheets.length > 1 && (
                <Text type="secondary">({sheets.length} листов)</Text>
              )}
            </Space>
          </Space>
        </Card>
      )}

      {/* Preview table */}
      {sheetData && sheetData.rowCount > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <Text strong>Предпросмотр данных</Text>
              <Text type="secondary">
                ({sheetData.rowCount} строк × {sheetData.colCount} колонок)
              </Text>
            </Space>
          }
        >
          <Table
            columns={previewColumns}
            dataSource={previewData}
            pagination={false}
            size="small"
            scroll={{ x: 'max-content' }}
            bordered
          />
          {sheetData.rowCount > 5 && (
            <Text type="secondary" style={{ marginTop: 8, display: 'block' }}>
              Показаны первые 5 строк из {sheetData.rowCount}
            </Text>
          )}
          {sheetData.colCount > 10 && (
            <Text type="secondary">
              Показаны первые 10 колонок из {sheetData.colCount}
            </Text>
          )}
        </Card>
      )}

      {/* Instructions */}
      {!sheetData && !isLoading && !error && (
        <Alert
          type="info"
          message="Инструкция"
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Загрузите Excel-файл с данными деталей</li>
              <li>Файл должен содержать колонки: высота, ширина, количество</li>
              <li>Опционально: обкатка, плёнка, примечание</li>
            </ul>
          }
          showIcon
        />
      )}
    </Space>
  );
};
