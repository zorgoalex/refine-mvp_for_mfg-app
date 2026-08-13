import React, { useState } from 'react';
import { IResourceComponentsProps } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { Form, Input, Select, InputNumber, Switch, Button, message, Space, Alert, Row, Col } from 'antd';
import { useNavigate } from 'react-router-dom';
import { can } from '../../utils/permissions';
import { sheetMaterialsApi, type SheetMaterialTypeInput } from '../../api/sheetMaterialsApi';

export const SheetMaterialCreate: React.FC<IResourceComponentsProps> = () => {
  const canManage = can('sheet_materials.manage');
  const navigate = useNavigate();
  const [form] = Form.useForm<SheetMaterialTypeInput>();
  const [saving, setSaving] = useState(false);

  const { selectProps: typeSelectProps } = useSelect({
    resource: 'material_types',
    optionLabel: 'material_type_name',
    optionValue: 'material_type_id',
  });
  const { selectProps: unitSelectProps } = useSelect({
    resource: 'units',
    optionLabel: 'unit_name',
    optionValue: 'unit_id',
  });
  const { selectProps: supplierSelectProps } = useSelect({
    resource: 'suppliers',
    optionLabel: 'supplier_name',
    optionValue: 'supplier_id',
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: 'vendors',
    optionLabel: 'vendor_name',
    optionValue: 'vendor_id',
  });

  if (!canManage) {
    return <Alert type="error" showIcon message="Недостаточно прав для создания листового материала" description="Требуется разрешение sheet_materials.manage" />;
  }

  const submit = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      await sheetMaterialsApi.create(values);
      message.success('Листовой материал создан');
      navigate('/sheet-material-types');
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message ?? 'Не удалось создать листовой материал');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <h2>Новый листовой материал</h2>
      <Form form={form} layout="vertical" initialValues={{ isActive: true, isCuttable: true, sortOrder: 100 }}>
        <Row gutter={16}>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
              <Input maxLength={200} placeholder="ЛДСП Egger H1234 16мм 2070x2800" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="materialTypeId" label="Тип материала" rules={[{ required: true, message: 'Укажите тип материала' }]}>
              <Select {...typeSelectProps} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="unitId" label="Единица измерения" rules={[{ required: true, message: 'Укажите единицу измерения' }]}>
              <Select {...unitSelectProps} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="thicknessMm" label="Толщина, мм" rules={[{ required: true, message: 'Укажите толщину' }]}>
              <InputNumber min={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="widthMm" label="Ширина, мм" rules={[{ required: true, message: 'Укажите ширину' }]}>
              <InputNumber min={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="heightMm" label="Высота, мм" rules={[{ required: true, message: 'Укажите высоту' }]}>
              <InputNumber min={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="supplierId" label="Поставщик">
              <Select {...supplierSelectProps} allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="vendorId" label="Производитель">
              <Select {...vendorSelectProps} allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="supplierArticle" label="Артикул поставщика">
              <Input maxLength={200} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="color" label="Цвет">
              <Input maxLength={100} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="refKey1c" label="Ключ 1С">
              <Input maxLength={36} placeholder="UUID из 1С" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="sortOrder" label="Порядок сортировки" rules={[{ required: true }]}>
              <InputNumber min={-32768} max={32767} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="texture" label="Текстура" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="isCuttable" label="Для раскроя" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="isActive" label="Активен" valuePropName="checked">
              <Switch defaultChecked />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item>
          <Space>
            <Button type="primary" onClick={submit} loading={saving}>
              Создать
            </Button>
            <Button onClick={() => navigate('/sheet-material-types')}>Отмена</Button>
          </Space>
        </Form.Item>
      </Form>
    </div>
  );
};
