// Step 4: Validation - Review and edit imported data before final import

import React, { useMemo } from 'react';
import { Table, InputNumber, Input, Tag, Space, Typography, Alert, Statistic, Card, Row, Col, Tooltip } from 'antd';
import { CheckCircleOutlined, WarningOutlined, CloseCircleOutlined } from '@ant-design/icons';
import type { ValidatedRow, ImportRow } from '../types/importTypes';

const { Text } = Typography;

interface ValidationStepProps {
  rows: ValidatedRow[];
  onUpdateRow: (index: number, field: keyof ImportRow, value: any) => void;
  errorCount: number;
  warningCount: number;
}

export const ValidationStep: React.FC<ValidationStepProps> = ({
  rows,
  onUpdateRow,
  errorCount,
  warningCount,
}) => {
  // Summary statistics
  const stats = useMemo(() => {
    const validCount = rows.filter(r => r.isValid).length;
    const totalQuantity = rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
    const totalArea = rows.reduce((sum, r) => {
      const h = (r.height || 0) / 1000; // mm to m
      const w = (r.width || 0) / 1000;
      const q = r.quantity || 0;
      return sum + (h * w * q);
    }, 0);

    return {
      total: rows.length,
      valid: validCount,
      invalid: rows.length - validCount,
      totalQuantity,
      totalArea: totalArea.toFixed(2),
    };
  }, [rows]);

  // Get error/warning for a specific field
  const getFieldStatus = (row: ValidatedRow, field: string): { type: 'error' | 'warning' | null; message: string | null } => {
    const error = row.errors.find(e => e.field === field);
    if (error) return { type: 'error', message: error.message };

    const warning = row.warnings.find(w => w.field === field);
    if (warning) return { type: 'warning', message: warning.message };

    return { type: null, message: null };
  };

  // Table columns
  const columns = [
    {
      title: '#',
      dataIndex: 'sourceRowIndex',
      key: 'sourceRowIndex',
      width: 50,
      render: (value: number) => <Text type="secondary">{value + 1}</Text>,
    },
    {
      title: 'Высота',
      dataIndex: 'height',
      key: 'height',
      width: 90,
      render: (value: number | null, record: ValidatedRow, index: number) => {
        const status = getFieldStatus(record, 'height');
        return (
          <Tooltip title={status.message}>
            <InputNumber
              value={value}
              onChange={(val) => onUpdateRow(index, 'height', val)}
              min={0}
              max={5000}
              style={{ width: '100%' }}
              status={status.type === 'error' ? 'error' : status.type === 'warning' ? 'warning' : undefined}
              size="small"
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Ширина',
      dataIndex: 'width',
      key: 'width',
      width: 90,
      render: (value: number | null, record: ValidatedRow, index: number) => {
        const status = getFieldStatus(record, 'width');
        return (
          <Tooltip title={status.message}>
            <InputNumber
              value={value}
              onChange={(val) => onUpdateRow(index, 'width', val)}
              min={0}
              max={3000}
              style={{ width: '100%' }}
              status={status.type === 'error' ? 'error' : status.type === 'warning' ? 'warning' : undefined}
              size="small"
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 70,
      render: (value: number | null, record: ValidatedRow, index: number) => {
        const status = getFieldStatus(record, 'quantity');
        return (
          <Tooltip title={status.message}>
            <InputNumber
              value={value}
              onChange={(val) => onUpdateRow(index, 'quantity', val)}
              min={1}
              max={1000}
              style={{ width: '100%' }}
              status={status.type === 'error' ? 'error' : status.type === 'warning' ? 'warning' : undefined}
              size="small"
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Обкатка',
      dataIndex: 'edgeTypeName',
      key: 'edgeTypeName',
      width: 100,
      render: (value: string | null, record: ValidatedRow) => {
        const status = getFieldStatus(record, 'edgeTypeName');
        return (
          <Space size={2}>
            <Text ellipsis style={{ maxWidth: 80 }}>{value || '—'}</Text>
            {record.edge_type_id ? (
              <Tag color="green" style={{ fontSize: 10 }}>✓</Tag>
            ) : value ? (
              <Tooltip title={status.message}>
                <Tag color="orange" style={{ fontSize: 10 }}>?</Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Плёнка',
      dataIndex: 'filmName',
      key: 'filmName',
      width: 100,
      render: (value: string | null, record: ValidatedRow) => {
        const status = getFieldStatus(record, 'filmName');
        return (
          <Space size={2}>
            <Text ellipsis style={{ maxWidth: 80 }}>{value || '—'}</Text>
            {record.film_id ? (
              <Tag color="green" style={{ fontSize: 10 }}>✓</Tag>
            ) : value ? (
              <Tooltip title={status.message}>
                <Tag color="orange" style={{ fontSize: 10 }}>?</Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Примечание',
      dataIndex: 'note',
      key: 'note',
      width: 120,
      render: (value: string | null, _: ValidatedRow, index: number) => (
        <Input
          value={value || ''}
          onChange={(e) => onUpdateRow(index, 'note', e.target.value || null)}
          placeholder="—"
          size="small"
        />
      ),
    },
    {
      title: 'Статус',
      key: 'status',
      width: 70,
      render: (_: any, record: ValidatedRow) => {
        if (record.isValid && record.warnings.length === 0) {
          return <Tag color="success" icon={<CheckCircleOutlined />}>OK</Tag>;
        }
        if (record.isValid && record.warnings.length > 0) {
          return (
            <Tooltip title={record.warnings.map(w => w.message).join('; ')}>
              <Tag color="warning" icon={<WarningOutlined />}>
                {record.warnings.length}
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Tooltip title={record.errors.map(e => e.message).join('; ')}>
            <Tag color="error" icon={<CloseCircleOutlined />}>
              {record.errors.length}
            </Tag>
          </Tooltip>
        );
      },
    },
  ];

  if (rows.length === 0) {
    return (
      <Alert
        type="warning"
        message="Нет данных для проверки"
        description="Вернитесь на предыдущие шаги и настройте импорт"
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Summary cards */}
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Всего строк"
              value={stats.total}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Готово к импорту"
              value={stats.valid}
              valueStyle={{ color: '#52c41a' }}
              suffix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Всего деталей"
              value={stats.totalQuantity}
              valueStyle={{ color: '#722ed1' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Площадь, м²"
              value={stats.totalArea}
              valueStyle={{ color: '#fa8c16' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Errors/Warnings summary */}
      {(errorCount > 0 || warningCount > 0) && (
        <Alert
          type={errorCount > 0 ? 'error' : 'warning'}
          message={
            <Space>
              {errorCount > 0 && (
                <Text type="danger">
                  <CloseCircleOutlined /> Ошибок: {errorCount}
                </Text>
              )}
              {warningCount > 0 && (
                <Text type="warning">
                  <WarningOutlined /> Предупреждений: {warningCount}
                </Text>
              )}
            </Space>
          }
          description={
            errorCount > 0
              ? 'Исправьте ошибки перед импортом. Строки с ошибками не будут импортированы.'
              : 'Предупреждения не блокируют импорт, но проверьте данные.'
          }
          showIcon
        />
      )}

      {/* Data table */}
      <Table
        dataSource={rows.map((row, index) => ({ ...row, key: index }))}
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        size="small"
        scroll={{ y: 300 }}
        rowClassName={(record) =>
          !record.isValid ? 'import-row-error' :
          record.warnings.length > 0 ? 'import-row-warning' : ''
        }
      />

      {/* Legend */}
      <Space>
        <Tag color="green">✓</Tag> <Text type="secondary">Найдено в справочнике</Text>
        <Tag color="orange">?</Tag> <Text type="secondary">Не найдено (будет использовано значение по умолчанию)</Text>
      </Space>

      <style>{`
        .import-row-error {
          background-color: #fff1f0 !important;
        }
        .import-row-warning {
          background-color: #fffbe6 !important;
        }
      `}</style>
    </Space>
  );
};
