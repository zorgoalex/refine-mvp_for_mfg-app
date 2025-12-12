// Step 4: Validation with inline editing and statistics

import React, { useCallback, useMemo } from 'react';
import { Table, InputNumber, Input, Select, Typography, Card, Row, Col, Statistic, Tag, Tooltip, Button, Popconfirm, Alert, Space } from 'antd';
import { DeleteOutlined, CheckCircleOutlined, ExclamationCircleOutlined, WarningOutlined, SwapOutlined } from '@ant-design/icons';
import type { ValidatedRow, ReferenceData } from '../types/importTypes';
import type { ImportStats, UnresolvedReferences } from '../hooks/useImportValidation';

const { Text } = Typography;

interface ValidationStepProps {
  validatedRows: ValidatedRow[];
  referenceData: ReferenceData;
  stats: ImportStats;
  unresolvedRefs: UnresolvedReferences;
  onUpdateRow: (index: number, field: keyof ValidatedRow, value: unknown) => void;
  onRemoveRow: (index: number) => void;
  onBatchReplace: (field: 'edge_type' | 'film' | 'material' | 'milling_type', originalValue: string, newId: number) => void;
}

export const ValidationStep: React.FC<ValidationStepProps> = ({
  validatedRows,
  referenceData,
  stats,
  unresolvedRefs,
  onUpdateRow,
  onRemoveRow,
  onBatchReplace,
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
      title: 'Обкат',
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
      title: 'Материал',
      dataIndex: 'material_id',
      key: 'material_id',
      width: 140,
      render: (value: number | null, row: ValidatedRow, index: number) => (
        <div>
          <RefSelectEditor
            value={value}
            items={referenceData.materials}
            onChange={(val) => onUpdateRow(index, 'material_id', val)}
          />
          {row.materialName && !value && (
            <Text type="secondary" style={{ fontSize: 10 }}>{row.materialName}</Text>
          )}
        </div>
      ),
    },
    {
      title: 'Фрезеровка',
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 140,
      render: (value: number | null, row: ValidatedRow, index: number) => (
        <div>
          <RefSelectEditor
            value={value}
            items={referenceData.millingTypes}
            onChange={(val) => onUpdateRow(index, 'milling_type_id', val)}
          />
          {row.millingTypeName && !value && (
            <Text type="secondary" style={{ fontSize: 10 }}>{row.millingTypeName}</Text>
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
      {/* Statistics cards - compact */}
      <Row gutter={8} style={{ marginBottom: 8 }}>
        <Col span={6}>
          <Card size="small" bodyStyle={{ padding: '8px 12px' }}>
            <Statistic
              title={<span style={{ fontSize: 11 }}>Всего строк</span>}
              value={stats.totalRows}
              valueStyle={{ fontSize: 14 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" bodyStyle={{ padding: '8px 12px' }}>
            <Statistic
              title={<span style={{ fontSize: 11 }}>Готово к импорту</span>}
              value={stats.validRows}
              valueStyle={{ fontSize: 14, color: '#52c41a' }}
              prefix={<CheckCircleOutlined style={{ fontSize: 12 }} />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" bodyStyle={{ padding: '8px 12px' }}>
            <Statistic
              title={<span style={{ fontSize: 11 }}>Общее количество</span>}
              value={stats.totalQuantity}
              valueStyle={{ fontSize: 14 }}
              suffix={<span style={{ fontSize: 11 }}>шт</span>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" bodyStyle={{ padding: '8px 12px' }}>
            <Statistic
              title={<span style={{ fontSize: 11 }}>Общая площадь</span>}
              value={stats.totalArea}
              valueStyle={{ fontSize: 14 }}
              suffix={<span style={{ fontSize: 11 }}>м²</span>}
              precision={2}
            />
          </Card>
        </Col>
      </Row>

      {/* Legend - compact */}
      <div style={{ marginBottom: 6 }}>
        <Tag color="success" style={{ fontSize: 11 }}><CheckCircleOutlined style={{ fontSize: 10 }} /> Готово</Tag>
        <Tag color="error" style={{ fontSize: 11 }}><ExclamationCircleOutlined style={{ fontSize: 10 }} /> Ошибка</Tag>
        <Tag color="warning" style={{ fontSize: 11 }}><WarningOutlined style={{ fontSize: 10 }} /> Предупреждение</Tag>
      </div>

      {/* Unresolved references section */}
      {(unresolvedRefs.edgeTypes.length > 0 || unresolvedRefs.films.length > 0 ||
        unresolvedRefs.materials.length > 0 || unresolvedRefs.millingTypes.length > 0) && (
        <Alert
          type="warning"
          showIcon
          icon={<SwapOutlined />}
          style={{ marginBottom: 8 }}
          message="Ненайденные значения"
          description={
            <div style={{ marginTop: 8 }}>
              {unresolvedRefs.edgeTypes.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>Обкатка:</Text>
                  <Space wrap style={{ marginLeft: 8 }}>
                    {unresolvedRefs.edgeTypes.map((ref) => (
                      <Space key={ref.originalValue} size={4}>
                        <Tag color="orange" style={{ fontSize: 11, margin: 0 }}>
                          {ref.originalValue} ({ref.count})
                        </Tag>
                        <Select
                          size="small"
                          placeholder="Заменить на..."
                          style={{ width: 280 }}
                          options={referenceData.edgeTypes.map(item => ({ label: item.name, value: item.id }))}
                          onChange={(val) => val && onBatchReplace('edge_type', ref.originalValue, val)}
                          showSearch
                          filterOption={(input, option) =>
                            (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </Space>
                    ))}
                  </Space>
                </div>
              )}
              {unresolvedRefs.films.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>Плёнка:</Text>
                  <Space wrap style={{ marginLeft: 8 }}>
                    {unresolvedRefs.films.map((ref) => (
                      <Space key={ref.originalValue} size={4}>
                        <Tag color="orange" style={{ fontSize: 11, margin: 0 }}>
                          {ref.originalValue} ({ref.count})
                        </Tag>
                        <Select
                          size="small"
                          placeholder="Заменить на..."
                          style={{ width: 280 }}
                          options={referenceData.films.map(item => ({ label: item.name, value: item.id }))}
                          onChange={(val) => val && onBatchReplace('film', ref.originalValue, val)}
                          showSearch
                          filterOption={(input, option) =>
                            (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </Space>
                    ))}
                  </Space>
                </div>
              )}
              {unresolvedRefs.materials.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>Материал:</Text>
                  <Space wrap style={{ marginLeft: 8 }}>
                    {unresolvedRefs.materials.map((ref) => (
                      <Space key={ref.originalValue} size={4}>
                        <Tag color="orange" style={{ fontSize: 11, margin: 0 }}>
                          {ref.originalValue} ({ref.count})
                        </Tag>
                        <Select
                          size="small"
                          placeholder="Заменить на..."
                          style={{ width: 280 }}
                          options={referenceData.materials.map(item => ({ label: item.name, value: item.id }))}
                          onChange={(val) => val && onBatchReplace('material', ref.originalValue, val)}
                          showSearch
                          filterOption={(input, option) =>
                            (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </Space>
                    ))}
                  </Space>
                </div>
              )}
              {unresolvedRefs.millingTypes.length > 0 && (
                <div>
                  <Text strong style={{ fontSize: 12 }}>Фрезеровка:</Text>
                  <Space wrap style={{ marginLeft: 8 }}>
                    {unresolvedRefs.millingTypes.map((ref) => (
                      <Space key={ref.originalValue} size={4}>
                        <Tag color="orange" style={{ fontSize: 11, margin: 0 }}>
                          {ref.originalValue} ({ref.count})
                        </Tag>
                        <Select
                          size="small"
                          placeholder="Заменить на..."
                          style={{ width: 280 }}
                          options={referenceData.millingTypes.map(item => ({ label: item.name, value: item.id }))}
                          onChange={(val) => val && onBatchReplace('milling_type', ref.originalValue, val)}
                          showSearch
                          filterOption={(input, option) =>
                            (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </Space>
                    ))}
                  </Space>
                </div>
              )}
            </div>
          }
        />
      )}

      {/* Validation table */}
      <div style={{ flex: 1 }}>
        <Table
          columns={columns}
          dataSource={validatedRows.map((row, index) => ({ ...row, key: index }))}
          pagination={false}
          size="small"
          scroll={{ x: 'max-content', y: 350 }}
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
