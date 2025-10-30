// Order Detail Modal
// Modal for creating/editing order details with auto-calculation

import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Row, Col, Select, Space, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';

interface OrderDetailModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  detail?: OrderDetail;
  onSave: (detail: Omit<OrderDetail, 'temp_id'>) => void;
  onCancel: () => void;
}

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  open,
  mode,
  detail,
  onSave,
  onCancel,
}) => {
  const [form] = Form.useForm();
  const [calculatedArea, setCalculatedArea] = useState<number>(0);

  // Load reference data with search
  const { selectProps: materialSelectProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(detail?.material_id ? { defaultValue: detail.material_id } : {}),
  });

  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.milling_type_id ? { defaultValue: detail.milling_type_id } : {}),
  });

  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.edge_type_id ? { defaultValue: detail.edge_type_id } : {}),
  });

  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(detail?.film_id ? { defaultValue: detail.film_id } : {}),
  });

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    ...(detail?.production_status_id ? { defaultValue: detail.production_status_id } : {}),
  });

  // Initialize form when detail changes
  useEffect(() => {
    if (open) {
      if (mode === 'edit' && detail) {
        form.setFieldsValue(detail);
        setCalculatedArea(detail.area || 0);
      } else {
        form.resetFields();
        form.setFieldsValue({
          quantity: 1,
          priority: 100,
        });
        setCalculatedArea(0);
      }
    }
  }, [open, mode, detail, form]);

  // Auto-calculate area when height or width changes
  const handleDimensionChange = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');

    console.log('[OrderDetailModal] handleDimensionChange - height:', height, 'width:', width);

    if (height && width && height > 0 && width > 0) {
      const area = (height * width) / 1000000; // Convert mm² to m²
      console.log('[OrderDetailModal] calculated area:', area, '(height * width / 1000000 =', height, '*', width, '/ 1000000)');
      setCalculatedArea(area);
      form.setFieldsValue({ area });
    } else {
      console.log('[OrderDetailModal] cannot calculate - invalid dimensions');
    }
  };

  const handleOk = async () => {
    try {
      const values = await form.validateFields();

      console.log('[OrderDetailModal] handleOk - form values:', values);
      console.log('[OrderDetailModal] handleOk - calculatedArea:', calculatedArea);

      // Prepare detail data
      const detailData: Omit<OrderDetail, 'temp_id'> = {
        ...detail, // Keep existing fields like detail_id, temp_id for edit mode
        ...values,
        area: calculatedArea,
      };

      console.log('[OrderDetailModal] handleOk - final detailData:', detailData);

      onSave(detailData);
      form.resetFields();
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  return (
    <Modal
      title={mode === 'create' ? 'Добавить деталь' : 'Редактировать деталь'}
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      width={800}
      okText="Сохранить"
      cancelText="Отмена"
    >
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Название детали"
              name="detail_name"
            >
              <Input placeholder="Опционально" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="Приоритет"
              name="priority"
              initialValue={100}
              tooltip="1 — наивысший приоритет, большее число — ниже"
            >
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                max={999}
                formatter={(value) => numberFormatter(value, 0)}
                parser={numberParser}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="Количество"
              name="quantity"
              rules={[{ required: true, message: 'Обязательное поле' }]}
              initialValue={1}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                formatter={(value) => numberFormatter(value, 0)}
                parser={numberParser}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label="Высота (мм)"
              name="height"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
                parser={numberParser}
                onChange={handleDimensionChange}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="Ширина (мм)"
              name="width"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
                parser={numberParser}
                onChange={handleDimensionChange}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="Площадь (м²)" name="area">
              <InputNumber
                style={{ width: '100%' }}
                disabled
                value={calculatedArea}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Материал"
              name="material_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...materialSelectProps}
                showSearch
                placeholder="Выберите материал"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open MaterialQuickCreate modal
                          console.log('Open MaterialQuickCreate');
                        }}
                      >
                        Создать материал
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Пленка"
              name="film_id"
            >
              <Select
                {...filmSelectProps}
                showSearch
                placeholder="Выберите пленку"
                allowClear
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open FilmQuickCreate modal
                          console.log('Open FilmQuickCreate');
                        }}
                      >
                        Создать пленку
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Тип фрезеровки"
              name="milling_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...millingTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open MillingTypeQuickCreate modal
                          console.log('Open MillingTypeQuickCreate');
                        }}
                      >
                        Создать тип фрезеровки
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Тип кромки"
              name="edge_type_id"
              rules={[{ required: true, message: 'Обязательное поле' }]}
            >
              <Select
                {...edgeTypeSelectProps}
                placeholder="Выберите тип"
                dropdownRender={(menu) => (
                  <>
                    {menu}
                    <Space style={{ padding: '8px' }}>
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          // TODO: Open EdgeTypeQuickCreate modal
                          console.log('Open EdgeTypeQuickCreate');
                        }}
                      >
                        Создать тип кромки
                      </Button>
                    </Space>
                  </>
                )}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label="Статус производства" name="production_status_id">
              <Select
                {...productionStatusSelectProps}
                placeholder="Выберите статус"
                allowClear
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Стоимость фрезеровки (за м²)" name="milling_cost_per_sqm">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                formatter={(value) => numberFormatter(value, 2)}
                parser={numberParser}
                addonAfter="₽"
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label="Примечание" name="note">
          <Input.TextArea rows={3} placeholder="Дополнительная информация" />
        </Form.Item>
      </Form>
    </Modal>
  );
};
