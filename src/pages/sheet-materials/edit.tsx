import { nameRule } from '../../utils/nameRules';
import React, { useState, useEffect } from 'react';
import { IResourceComponentsProps, useOne } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { Form, Input, Select, InputNumber, Switch, Button, message, Space, Alert, Spin, Row, Col } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { can } from '../../utils/permissions';
import { sheetMaterialsApi, type SheetMaterialTypeInput } from '../../api/sheetMaterialsApi';
import { useRecordTabTitle } from '../../utils/recordTitle';
import { NomenclatureFormItems, nomenclaturePayload } from '../../components/NomenclatureFields';
import { useSheetMaterialCapabilities } from './useSheetMaterialNomenclature';
import { sheetMaterialEditSource } from './editSource';
import { OnecItemField } from './OnecItemField';
import { fillNomenclatureFromOnec } from './onecItemFill';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export const SheetMaterialEdit: React.FC<IResourceComponentsProps> = () => {
  const canManage = can('sheet_materials.manage');
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [form] = Form.useForm<SheetMaterialTypeInput>();
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading } = useOne({
    resource: 'sheet_material_types',
    id: id ? Number(id) : 0,
    queryOptions: { enabled: !!id && canManage },
    meta: { idColumnName: 'sheet_material_type_id' },
  });
  const record = data?.data;
  // Черновик и версия — из ОДНОГО снимка backend (GET /sheet-material-types/:id): поля и expectedVersion одной версии,
  // иначе чужое изменение между двумя чтениями затёрлось бы без 409. Hasura-запись — запасной источник, если backend
  // не ответил (тогда и новых полей нет).
  const capabilities = useSheetMaterialCapabilities(canManage);
  const nomenclatureSupported = capabilities.supported;
  const backendQuery = useQuery({
    queryKey: ['sheet-materials', 'one', Number(id)],
    queryFn: () => sheetMaterialsApi.get(Number(id)),
    enabled: !!id && canManage,
    retry: false,
    staleTime: 0,
    cacheTime: 0,
  });
  const snapshotReady = !backendQuery.isLoading;
  const source = snapshotReady ? sheetMaterialEditSource(backendQuery.data, record) : null;
  const expectedVersion = source?.expectedVersion;
  const nomenclatureEditable = nomenclatureSupported && source?.fromBackend === true;

  useRecordTabTitle({
    resourceLabel: 'Листовые материалы',
    actionLabel: 'Редактирование',
    record,
    fallbackId: id,
    preferredFields: ['name'],
  });

  useEffect(() => {
    if (!snapshotReady) return;
    const initial = sheetMaterialEditSource(backendQuery.data, record);
    if (initial) form.setFieldsValue(initial.values);
  }, [snapshotReady, backendQuery.data, record, form]);

  const { selectProps: typeSelectProps } = useSelect({
    resource: 'material_types',
    optionLabel: 'material_type_name',
    optionValue: 'material_type_id',
    defaultValue: record?.material_type_id,
  });
  const { selectProps: unitSelectProps } = useSelect({
    resource: 'units',
    optionLabel: 'unit_name',
    optionValue: 'unit_id',
    defaultValue: record?.unit_id,
  });
  const { selectProps: supplierSelectProps } = useSelect({
    resource: 'suppliers',
    optionLabel: 'supplier_name',
    optionValue: 'supplier_id',
    defaultValue: record?.supplier_id,
  });
  const { selectProps: vendorSelectProps } = useSelect({
    resource: 'vendors',
    optionLabel: 'vendor_name',
    optionValue: 'vendor_id',
    defaultValue: record?.vendor_id,
  });

  if (!canManage) {
    return <Alert type="error" showIcon message="Недостаточно прав для редактирования листового материала" description="Требуется разрешение sheet_materials.manage" />;
  }

  if (isLoading || backendQuery.isLoading || capabilities.isLoading) return <Spin />;

  const submit = async () => {
    if (!record || !id || expectedVersion === undefined) return;
    setSaving(true);
    try {
      const { nomenclatureType, nomenclatureCategory, note, ...values } = await form.validateFields();
      await sheetMaterialsApi.update(Number(id), { ...values, ...nomenclaturePayload({ nomenclatureType, nomenclatureCategory, note }, nomenclatureEditable) }, expectedVersion);
      // Список и карточка читают новые поля из кеша backend-списка: без сброса показали бы прежние значения.
      await queryClient.invalidateQueries({ queryKey: ['sheet-materials'] });
      message.success('Листовой материал обновлён');
      navigate(`/sheet-material-types/show/${id}`);
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message ?? 'Не удалось обновить листовой материал');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <h2>Редактировать листовой материал</h2>
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="name" label="Название" rules={[...([{ required: true, message: 'Укажите название' }]), nameRule("name", 200)]}>
              <Input maxLength={200} />
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
            <Form.Item name="refKey1c" label="Позиция 1С">
              <OnecItemField sheetId={id ? Number(id) : null} onPick={(item) => { if (nomenclatureEditable) fillNomenclatureFromOnec(form, item); }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item label="Conversion Key">
              <Input value={record?.conversion_key ?? '—'} disabled />
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
              <Switch />
            </Form.Item>
          </Col>
          {nomenclatureEditable && <NomenclatureFormItems colProps={{ xs: 24, sm: 12, md: 8 }} />}
        </Row>
        <Form.Item>
          <Space>
            <Button type="primary" onClick={submit} loading={saving}>
              Сохранить
            </Button>
            <Button onClick={() => navigate(`/sheet-material-types/show/${id}`)}>Отмена</Button>
          </Space>
        </Form.Item>
      </Form>
    </div>
  );
};
