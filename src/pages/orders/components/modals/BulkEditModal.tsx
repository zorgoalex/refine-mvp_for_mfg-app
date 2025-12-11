// Bulk Edit Modal
// Modal for bulk editing multiple order details at once

import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Row, Col, Select, Checkbox, Alert, Divider, Typography } from 'antd';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

const { Text } = Typography;

interface BulkEditModalProps {
  open: boolean;
  selectedCount: number;
  totalCount: number;
  onApply: (changes: Partial<OrderDetail>, applyToAll: boolean) => void;
  onCancel: () => void;
}

// Fields that can be bulk edited
interface BulkEditFields {
  height?: number;
  width?: number;
  quantity?: number;
  material_id?: number;
  note?: string;
  milling_type_id?: number;
  edge_type_id?: number;
  film_id?: number | null;
  milling_cost_per_sqm?: number;
  production_status_id?: number | null;
  priority?: number;
}

// Track which fields are enabled for editing
interface EnabledFields {
  height: boolean;
  width: boolean;
  quantity: boolean;
  material_id: boolean;
  note: boolean;
  milling_type_id: boolean;
  edge_type_id: boolean;
  film_id: boolean;
  milling_cost_per_sqm: boolean;
  production_status_id: boolean;
  priority: boolean;
}

export const BulkEditModal: React.FC<BulkEditModalProps> = ({
  open,
  selectedCount,
  totalCount,
  onApply,
  onCancel,
}) => {
  const [form] = Form.useForm<BulkEditFields>();
  const [applyToAll, setApplyToAll] = useState(false);
  const [enabledFields, setEnabledFields] = useState<EnabledFields>({
    height: false,
    width: false,
    quantity: false,
    material_id: false,
    note: false,
    milling_type_id: false,
    edge_type_id: false,
    film_id: false,
    milling_cost_per_sqm: false,
    production_status_id: false,
    priority: false,
  });

  // Count enabled fields
  const enabledCount = Object.values(enabledFields).filter(Boolean).length;

  // Load reference data
  const { selectProps: materialSelectProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: open },
  });

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      form.resetFields();
      setApplyToAll(false);
      setEnabledFields({
        height: false,
        width: false,
        quantity: false,
        material_id: false,
        note: false,
        milling_type_id: false,
        edge_type_id: false,
        film_id: false,
        milling_cost_per_sqm: false,
        production_status_id: false,
        priority: false,
      });
    }
  }, [open, form]);

  // Toggle field enabled state
  const toggleField = (field: keyof EnabledFields) => {
    setEnabledFields(prev => ({
      ...prev,
      [field]: !prev[field],
    }));
    // Clear field value when disabled
    if (enabledFields[field]) {
      form.setFieldValue(field, undefined);
    }
  };

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      // Build changes object with only enabled fields
      const changes: Partial<OrderDetail> = {};

      if (enabledFields.height && values.height !== undefined) {
        changes.height = values.height;
      }
      if (enabledFields.width && values.width !== undefined) {
        changes.width = values.width;
      }
      if (enabledFields.quantity && values.quantity !== undefined) {
        changes.quantity = values.quantity;
      }
      if (enabledFields.material_id && values.material_id !== undefined) {
        changes.material_id = values.material_id;
      }
      if (enabledFields.note && values.note !== undefined) {
        changes.note = values.note;
      }
      if (enabledFields.milling_type_id && values.milling_type_id !== undefined) {
        changes.milling_type_id = values.milling_type_id;
      }
      if (enabledFields.edge_type_id && values.edge_type_id !== undefined) {
        changes.edge_type_id = values.edge_type_id;
      }
      if (enabledFields.film_id) {
        changes.film_id = values.film_id ?? null;
      }
      if (enabledFields.milling_cost_per_sqm && values.milling_cost_per_sqm !== undefined) {
        changes.milling_cost_per_sqm = values.milling_cost_per_sqm;
      }
      if (enabledFields.production_status_id) {
        changes.production_status_id = values.production_status_id ?? null;
      }
      if (enabledFields.priority && values.priority !== undefined) {
        changes.priority = values.priority;
      }

      // Check if any changes were made
      if (Object.keys(changes).length === 0) {
        return; // No changes to apply
      }

      onApply(changes, applyToAll);
    } catch (error) {
      console.error('[BulkEditModal] Validation failed:', error);
    }
  };

  const targetCount = applyToAll ? totalCount : selectedCount;
  const hasSelection = selectedCount > 0 || applyToAll;

  return (
    <Modal
      title="Групповые действия"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      width={700}
      okText="Применить"
      cancelText="Отмена"
      okButtonProps={{
        disabled: enabledCount === 0 || !hasSelection
      }}
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
    >
      {/* Info alert */}
      <Alert
        message={
          <span>
            Изменения будут применены к{' '}
            <Text strong style={{ color: '#1890ff' }}>
              {targetCount}
            </Text>{' '}
            {targetCount === 1 ? 'позиции' : targetCount < 5 ? 'позициям' : 'позициям'}
          </span>
        }
        description="Отметьте чекбоксами поля, которые хотите изменить. Пустые значения также будут применены (например, для очистки примечания)."
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      {/* Apply to all checkbox */}
      <div style={{ marginBottom: 16, padding: '8px 12px', backgroundColor: '#fafafa', borderRadius: 4 }}>
        <Checkbox
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
        >
          <Text strong>Применить ко всем деталям заказа</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            ({totalCount} позиций)
          </Text>
        </Checkbox>
        {!applyToAll && selectedCount === 0 && (
          <div style={{ marginTop: 4 }}>
            <Text type="warning" style={{ fontSize: 12 }}>
              Выберите позиции в таблице или включите "Применить ко всем деталям"
            </Text>
          </div>
        )}
      </div>

      <Divider style={{ margin: '12px 0' }} />

      <Form form={form} layout="vertical">
        {/* Размеры и материал */}
        <Row gutter={16}>
          {/* Высота */}
          <Col span={6}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.height}
                  onChange={() => toggleField('height')}
                >
                  Высота (мм)
                </Checkbox>
              }
            >
              <Form.Item name="height" noStyle>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  parser={numberParser}
                  disabled={!enabledFields.height}
                  placeholder="мм"
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Ширина */}
          <Col span={6}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.width}
                  onChange={() => toggleField('width')}
                >
                  Ширина (мм)
                </Checkbox>
              }
            >
              <Form.Item name="width" noStyle>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  parser={numberParser}
                  disabled={!enabledFields.width}
                  placeholder="мм"
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Материал */}
          <Col span={12}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.material_id}
                  onChange={() => toggleField('material_id')}
                >
                  Материал
                </Checkbox>
              }
            >
              <Form.Item name="material_id" noStyle>
                <Select
                  {...materialSelectProps}
                  placeholder="Выберите материал"
                  showSearch
                  filterOption={(input, option) =>
                    ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
                  }
                  disabled={!enabledFields.material_id}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form.Item>
          </Col>
        </Row>

        {/* Количество, приоритет, цена */}
        <Row gutter={16}>
          {/* Количество */}
          <Col span={8}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.quantity}
                  onChange={() => toggleField('quantity')}
                >
                  Количество
                </Checkbox>
              }
            >
              <Form.Item name="quantity" noStyle>
                <InputNumber
                  style={{ width: '100%' }}
                  min={1}
                  precision={0}
                  disabled={!enabledFields.quantity}
                  placeholder="Введите количество"
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Приоритет */}
          <Col span={8}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.priority}
                  onChange={() => toggleField('priority')}
                >
                  Приоритет
                </Checkbox>
              }
            >
              <Form.Item name="priority" noStyle>
                <InputNumber
                  style={{ width: '100%' }}
                  min={1}
                  max={100}
                  disabled={!enabledFields.priority}
                  placeholder="1-100"
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Стоимость за кв.м. */}
          <Col span={8}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.milling_cost_per_sqm}
                  onChange={() => toggleField('milling_cost_per_sqm')}
                >
                  Цена за м²
                </Checkbox>
              }
            >
              <Form.Item name="milling_cost_per_sqm" noStyle>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  parser={numberParser}
                  addonAfter={CURRENCY_SYMBOL}
                  disabled={!enabledFields.milling_cost_per_sqm}
                  placeholder="Цена"
                />
              </Form.Item>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          {/* Фрезеровка */}
          <Col span={12}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.milling_type_id}
                  onChange={() => toggleField('milling_type_id')}
                >
                  Фрезеровка
                </Checkbox>
              }
            >
              <Form.Item name="milling_type_id" noStyle>
                <Select
                  {...millingTypeSelectProps}
                  placeholder="Выберите тип фрезеровки"
                  showSearch
                  filterOption={(input, option) =>
                    ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
                  }
                  disabled={!enabledFields.milling_type_id}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Обкат */}
          <Col span={12}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.edge_type_id}
                  onChange={() => toggleField('edge_type_id')}
                >
                  Обкат
                </Checkbox>
              }
            >
              <Form.Item name="edge_type_id" noStyle>
                <Select
                  {...edgeTypeSelectProps}
                  placeholder="Выберите тип обката"
                  showSearch
                  filterOption={(input, option) =>
                    ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
                  }
                  disabled={!enabledFields.edge_type_id}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          {/* Плёнка */}
          <Col span={12}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.film_id}
                  onChange={() => toggleField('film_id')}
                >
                  Плёнка
                </Checkbox>
              }
            >
              <Form.Item name="film_id" noStyle>
                <Select
                  {...filmSelectProps}
                  placeholder="Выберите плёнку"
                  showSearch
                  allowClear
                  filterOption={(input, option) =>
                    ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
                  }
                  disabled={!enabledFields.film_id}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form.Item>
          </Col>

          {/* Статус */}
          <Col span={12}>
            <Form.Item
              label={
                <Checkbox
                  checked={enabledFields.production_status_id}
                  onChange={() => toggleField('production_status_id')}
                >
                  Статус производства
                </Checkbox>
              }
            >
              <Form.Item name="production_status_id" noStyle>
                <Select
                  {...productionStatusSelectProps}
                  placeholder="Выберите статус"
                  showSearch
                  allowClear
                  filterOption={(input, option) =>
                    ((option?.label as string) || '').toLowerCase().includes(input.toLowerCase())
                  }
                  disabled={!enabledFields.production_status_id}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form.Item>
          </Col>
        </Row>

        {/* Примечание */}
        <Form.Item
          label={
            <Checkbox
              checked={enabledFields.note}
              onChange={() => toggleField('note')}
            >
              Примечание
            </Checkbox>
          }
        >
          <Form.Item name="note" noStyle>
            <Input.TextArea
              rows={2}
              placeholder="Введите примечание (или оставьте пустым для очистки)"
              disabled={!enabledFields.note}
            />
          </Form.Item>
        </Form.Item>
      </Form>

      {/* Summary */}
      {enabledCount > 0 && (
        <div style={{ marginTop: 12, padding: '8px 12px', backgroundColor: '#e6f7ff', borderRadius: 4 }}>
          <Text>
            Будет изменено полей: <Text strong>{enabledCount}</Text>
          </Text>
        </div>
      )}
    </Modal>
  );
};
