// Step 1: PDF File Upload with parsing results preview

import React, { useCallback } from 'react';
import { Upload, Table, Typography, Space, Alert, Spin, Descriptions, Tag } from 'antd';
import { InboxOutlined, FilePdfOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { PdfParsedResult } from '../types/pdfTypes';
import type { ImportRow } from '../types/importTypes';

const { Dragger } = Upload;
const { Text, Title } = Typography;

interface PdfUploadStepProps {
  isLoading: boolean;
  error: string | null;
  result: PdfParsedResult | null;
  importRows: ImportRow[];
  onFileUpload: (file: File) => Promise<void>;
}

export const PdfUploadStep: React.FC<PdfUploadStepProps> = ({
  isLoading,
  error,
  result,
  importRows,
  onFileUpload,
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
    accept: '.pdf',
    customRequest: handleUpload,
    showUploadList: false,
    disabled: isLoading,
  };

  // Preview columns for parsed details
  const previewColumns = [
    {
      title: '№',
      dataIndex: 'sourceRowIndex',
      key: 'index',
      width: 50,
      render: (_: unknown, __: unknown, index: number) => index + 1,
    },
    {
      title: 'Название',
      dataIndex: 'detailName',
      key: 'detailName',
      width: 200,
      ellipsis: true,
      render: (value: string) => {
        // Format: "position~~designation~~name" (e.g., "1~~11.02~~Бок L")
        const parts = (value || '').split('~~');
        const position = parts[0];
        const designation = parts[1];
        const name = parts[2];
        return (
          <span>
            <Text type="secondary">{position}. </Text>
            <Text strong>{designation}</Text>
            {name && <Text type="secondary"> — {name}</Text>}
          </span>
        );
      },
    },
    {
      title: 'Размер (мм)',
      key: 'size',
      width: 120,
      render: (_: unknown, record: ImportRow) => (
        <Text>{record.height} × {record.width}</Text>
      ),
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 70,
      align: 'center' as const,
    },
    {
      title: 'Фрезеровка',
      dataIndex: 'millingTypeName',
      key: 'milling',
      width: 120,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Плёнка',
      dataIndex: 'filmName',
      key: 'film',
      width: 180,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
    {
      title: 'Примечание',
      dataIndex: 'note',
      key: 'note',
      width: 100,
      ellipsis: true,
      render: (value: string | null) => value || <Text type="secondary">—</Text>,
    },
  ];

  const hasParseErrors = result?.parseErrors && result.parseErrors.length > 0;

  return (
    <div style={{ padding: '16px 0' }}>
      <Spin spinning={isLoading}>
        <Dragger {...uploadProps} style={{ marginBottom: 24 }}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ fontSize: 48, color: '#f5222d' }} />
          </p>
          <p className="ant-upload-text">
            Перетащите PDF-файл сюда или нажмите для выбора
          </p>
          <p className="ant-upload-hint">
            Поддерживается формат: .pdf (до 20 МБ)
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

        {result && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {/* Metadata section */}
            <Descriptions
              title={
                <Space>
                  <FilePdfOutlined style={{ color: '#f5222d' }} />
                  <span>Информация о документе</span>
                </Space>
              }
              bordered
              size="small"
              column={2}
            >
              <Descriptions.Item label="Присадка">
                <Tag color="blue">№ {result.metadata.orderNumber}</Tag>
                {result.metadata.orderName && (
                  <Text> / {result.metadata.orderName}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Материал">
                {result.metadata.material || <Text type="secondary">Не указан</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Найдено деталей">
                <Space>
                  <Text strong style={{ fontSize: 16 }}>{result.stats.totalQuantity}</Text>
                  {result.metadata.totalCount && (
                    result.stats.totalQuantity === result.metadata.totalCount ? (
                      <Tag icon={<CheckCircleOutlined />} color="success">
                        Совпадает с ожидаемым ({result.metadata.totalCount})
                      </Tag>
                    ) : (
                      <Tag icon={<WarningOutlined />} color="warning">
                        Ожидалось {result.metadata.totalCount}
                      </Tag>
                    )
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="Найдено позиций">
                <Text strong style={{ fontSize: 16 }}>{result.stats.positionsCount}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Страниц">
                {result.pages}
              </Descriptions.Item>
            </Descriptions>

            {/* Parse errors */}
            {hasParseErrors && (
              <Alert
                type="warning"
                message="Предупреждения при разборе"
                description={
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {result.parseErrors.map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                }
                showIcon
              />
            )}

            {/* Preview table */}
            {importRows.length > 0 && (
              <div>
                <Title level={5} style={{ marginBottom: 8 }}>
                  Предпросмотр (первые 10 деталей):
                </Title>
                <Table
                  columns={previewColumns}
                  dataSource={importRows.slice(0, 10).map((row, idx) => ({ ...row, key: idx }))}
                  pagination={false}
                  size="small"
                  scroll={{ x: 'max-content' }}
                  bordered
                  style={{ fontSize: 12 }}
                />
                {importRows.length > 10 && (
                  <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
                    Показаны первые 10 деталей из {importRows.length}.
                    Все детали будут доступны на следующем шаге.
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
