// Step 4: Validation with inline editing and statistics

import React, { useCallback, useMemo } from 'react';
import { Table, InputNumber, Input, Select, Typography, Card, Row, Col, Statistic, Tag, Tooltip, Button, Popconfirm } from 'antd';
import { DeleteOutlined, CheckCircleOutlined, ExclamationCircleOutlined, WarningOutlined } from '@ant-design/icons';
import type { ValidatedRow, ReferenceData } from '../types/importTypes';
import type { ImportStats } from '../hooks/useImportValidation';

const { Text } = Typography;

interface ValidationStepProps {
  validatedRows: ValidatedRow[];
  referenceData: ReferenceData;
  stats: ImportStats;
  onUpdateRow: (index: number, field: keyof ValidatedRow, value: unknown) => void;
  onRemoveRow: (index: number) => void;
}

export const ValidationStep: React.FC<ValidationStepProps> = ({
  validatedRows,
  referenceData,
  stats,
  onUpdateRow,
  onRemoveRow,
}) => {
  // Inline number editor
  const NumberEditor = useCallback(({ value, onChange, min = 0 }: { value: number | null | undefined; onChange: (val: number | null) => void; min?: number }) => (
    <InputNumber
      value={value ?? undefined}
      onChange={(val) => onChange(val)}
      min={min}
      size="small"
      style={{ width: '100%' }}
    />
  ), []);

  // Inline text editor
  const TextEditor = useCallback(({ value, onChange }: { value: string | null | undefined; onChange: (val: string | null) => void }) => (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      size="small"
      style={{ width: '100%' }}
    />
  ), []);

  // Reference select editor
  const RefSelectEditor = useCallback(({
    value,
    items,
    onChange,
  }: {
    value: number | null | undefined;
    items: { id: number; name: string }[];
    onChange: (val: number | null) => void;
  }) => (
    <Select
      value={value ?? undefined}
      onChange={(val) => onChange(val ?? null)}
      options={items.map(item => ({ label: item.name, value: item.id }))}
      size="small"
      style={{ width: '100%' }}
      allowClear
      placeholder="Выбрать..."
      showSearch
      filterOption={(input, option) =>
        (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
      }
    />
  ), []);

  // Status icon
  const StatusIcon = useCallback(({ row }: { row: ValidatedRow }) => {
    if (row.isValid && row.warnings.length === 0) {
      return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    }
    if (!row.isValid) {
      return (
        <Tooltip title={row.errors.map(e => e.message).join('; ')}>
          <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
        </Tooltip>
      );
    }
    return (
      <Tooltip title={row.warnings.map(w => w.message).join('; ')}>
        <WarningOutlined style={{ color: '#faad14' }} />
      </Tooltip>
    );
  }, []);

  const columns = useMemo(() => [
    {
      title: '',
      dataIndex: 'status',
      key: 'status',
      width: 40,
      fixed: 'left' as const,
      render: (_: unknown, row: ValidatedRow) => <StatusIcon row={row} />,
    },
    {
      title: '#',
      dataIndex: 'sourceRowIndex',
      key: 'sourceRowIndex',
      width: 50,
      fixed: 'left' as const,
      render: (val: number) => val + 1,
    },
    {
      title: 'Высота',
      dataIndex: 'height',
      key: 'height',
      width: 90,
      render: (value: number | null, _: ValidatedRow, index: number) => (
        <NumberEditor value={value} onChange={(val) => onUpdateRow(index, 'height', val)} min={1} />
      ),
    },
    {
      title: 'Ширина',
      dataIndex: 'width',
      key: 'width',
      width: 90,
      render: (value: number | null, _: ValidatedRow, index: number) => (
        <NumberEditor value={value} onChange={(val) => onUpdateRow(index, 'width', val)} min={1} />
      ),
    },
    {
      title: 'Кол-во',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      render: (value: number | null, _: ValidatedRow, index: number) => (
        <NumberEditor value={value} onChange={(val) => onUpdateRow(index, 'quantity', val)} min={1} />
      ),
    },
    {
      title: 'Обкатка',
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 140,
      render: (value: number | null, row: ValidatedRow, index: number) => (
        <div>
          <RefSelectEditor
            value={value}
            items={referenceData.edgeTypes}
            onChange={(val) => onUpdateRow(index, 'edge_type_id', val)}
          />
          {row.edgeTypeName && !value && (
            <Text type="secondary" style={{ fontSize: 10 }}>{row.edgeTypeName}</Text>
          )}
        </div>
      ),
    },
    {
      title: 'Плёнка',
      dataIndex: 'film_id',
      key: 'film_id',
      width: 140,
      render: (value: number | null, row: ValidatedRow, index: number) => (
        <div>
          <RefSelectEditor
            value={value}
            items={referenceData.films}
            onChange={(val) => onUpdateRow(index, 'film_id', val)}
          />
          {row.filmName && !value && (
            <Text type="secondary" style={{ fontSize: 10 }}>{row.filmName}</Text>
          )}
        </div>
      ),
    },
    {
      title: 'Название',
      dataIndex: 'detailName',
      key: 'detailName',
      width: 150,
      render: (value: string | null, _: ValidatedRow, index: number) => (
        <TextEditor value={value} onChange={(val) => onUpdateRow(index, 'detailName', val)} />
      ),
    },
    {
      title: 'Примечание',
      dataIndex: 'note',
      key: 'note',
      width: 150,
      render: (value: string | null, _: ValidatedRow, index: number) => (
        <TextEditor value={value} onChange={(val) => onUpdateRow(index, 'note', val)} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      fixed: 'right' as const,
      render: (_: unknown, __: ValidatedRow, index: number) => (
        <Popconfirm
          title="Удалить строку?"
          onConfirm={() => onRemoveRow(index)}
          okText="Да"
          cancelText="Нет"
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ], [referenceData, onUpdateRow, onRemoveRow, NumberEditor, TextEditor, RefSelectEditor, StatusIcon]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Statistics cards */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Всего строк"
              value={stats.totalRows}
              valueStyle={{ fontSize: 20 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Готово к импорту"
              value={stats.validRows}
              valueStyle={{ fontSize: 20, color: '#52c41a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Общее количество"
              value={stats.totalQuantity}
              valueStyle={{ fontSize: 20 }}
              suffix="шт"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Общая площадь"
              value={stats.totalArea}
              valueStyle={{ fontSize: 20 }}
              suffix="м²"
              precision={2}
            />
          </Card>
        </Col>
      </Row>

      {/* Legend */}
      <div style={{ marginBottom: 8 }}>
        <Tag color="success"><CheckCircleOutlined /> Готово</Tag>
        <Tag color="error"><ExclamationCircleOutlined /> Ошибка</Tag>
        <Tag color="warning"><WarningOutlined /> Предупреждение</Tag>
      </div>

      {/* Validation table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Table
          columns={columns}
          dataSource={validatedRows.map((row, index) => ({ ...row, key: index }))}
          pagination={false}
          size="small"
          scroll={{ x: 'max-content', y: 400 }}
          bordered
          rowClassName={(row) => {
            if (!row.isValid) return 'row-error';
            if (row.warnings.length > 0) return 'row-warning';
            return '';
          }}
        />
      </div>

      <style>{`
        .row-error {
          background-color: #fff2f0 !important;
        }
        .row-warning {
          background-color: #fffbe6 !important;
        }
      `}</style>
    </div>
  );
};
