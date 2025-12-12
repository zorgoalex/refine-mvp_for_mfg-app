// Step 1: File Upload with drag-and-drop and sheet selection

import React, { useCallback } from 'react';
import { Upload, Select, Table, Typography, Space, Alert, Spin } from 'antd';
import { InboxOutlined, FileExcelOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { ParsedSheet } from '../types/importTypes';

const { Dragger } = Upload;
const { Text, Title } = Typography;

interface FileUploadStepProps {
  sheets: string[];
  selectedSheet: string | null;
  sheetData: ParsedSheet | null;
  isLoading: boolean;
  error: string | null;
  onFileUpload: (file: File) => Promise<void>;
  onSheetSelect: (sheetName: string) => void;
}

export const FileUploadStep: React.FC<FileUploadStepProps> = ({
  sheets,
  selectedSheet,
  sheetData,
  isLoading,
  error,
  onFileUpload,
  onSheetSelect,
}) => {
  const handleUpload: UploadProps['customRequest'] = useCallback(async (options) => {
    const { file, onSuccess, onError } = options;
    try {
      await onFileUpload(file as File);
      onSuccess?.({});
    } catch (err) {
      onError?.(err as Error);
    }
  }, [onFileUpload]);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.xlsx,.xls,.xlsm,.xlsb',
    customRequest: handleUpload,
    showUploadList: false,
    disabled: isLoading,
  };

  // Preview columns for the table
  const previewColumns = sheetData?.headers.slice(0, 10).map((header, index) => ({
    title: header,
    dataIndex: index.toString(),
    key: header,
    width: 100,
    ellipsis: true,
    render: (value: unknown) => (
      <Text style={{ fontSize: 12 }} ellipsis>
        {value != null ? String(value) : ''}
      </Text>
    ),
  })) || [];

  // Preview data (first 5 rows)
  const previewData = sheetData?.data.slice(0, 5).map((row, rowIndex) => {
    const rowData: Record<string, unknown> = { key: rowIndex };
    row.slice(0, 10).forEach((cell, colIndex) => {
      rowData[colIndex.toString()] = cell;
    });
    return rowData;
  }) || [];

  return (
    <div style={{ padding: '16px 0' }}>
      <Spin spinning={isLoading}>
        <Dragger {...uploadProps} style={{ marginBottom: 24 }}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ fontSize: 48, color: '#1890ff' }} />
          </p>
          <p className="ant-upload-text">
            Перетащите Excel-файл сюда или нажмите для выбора
          </p>
          <p className="ant-upload-hint">
            Поддерживаются форматы: .xlsx, .xls, .xlsm, .xlsb (до 10 МБ)
          </p>
        </Dragger>

        {error && (
          <Alert
            type="error"
            message="Ошибка загрузки"
            description={error}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {sheets.length > 0 && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <Text strong>Выберите лист:</Text>
              <Select
                value={selectedSheet}
                onChange={onSheetSelect}
                style={{ width: 300, marginLeft: 12 }}
                options={sheets.map(name => ({ label: name, value: name }))}
                suffixIcon={<FileExcelOutlined />}
              />
              {sheetData && (
                <Text type="secondary" style={{ marginLeft: 12 }}>
                  {sheetData.rowCount} строк × {sheetData.colCount} колонок
                </Text>
              )}
            </div>

            {sheetData && previewData.length > 0 && (
              <div>
                <Title level={5} style={{ marginBottom: 8 }}>
                  Предпросмотр (первые 5 строк):
                </Title>
                <Table
                  columns={previewColumns}
                  dataSource={previewData}
                  pagination={false}
                  size="small"
                  scroll={{ x: 'max-content' }}
                  bordered
                  style={{ fontSize: 12 }}
                />
                {sheetData.colCount > 10 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Показаны первые 10 колонок из {sheetData.colCount}
                  </Text>
                )}
              </div>
            )}
          </Space>
        )}
      </Spin>
    </div>
  );
};
