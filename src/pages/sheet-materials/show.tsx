import React from 'react';
import { useShow, IResourceComponentsProps, useOne } from '@refinedev/core';
import { Show, TextField, DateField, EditButton } from '@refinedev/antd';
import { Typography, Badge, Row, Col, Divider, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import { can } from '../../utils/permissions';
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useRecordTabTitle } from '../../utils/recordTitle';

const { Title } = Typography;

export const SheetMaterialShow: React.FC<IResourceComponentsProps> = () => {
  const canManage = can('sheet_materials.manage');
  const { id } = useParams<{ id: string }>();
  const { queryResult } = useShow({ meta: { idColumnName: 'sheet_material_type_id' } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  useRecordTabTitle({
    resourceLabel: 'Листовые материалы',
    actionLabel: 'Просмотр',
    record,
    fallbackId: id,
    preferredFields: ['name'],
  });

  const { data: typeOne } = useOne({ resource: 'material_types', id: record?.material_type_id, queryOptions: { enabled: !!record?.material_type_id } });
  const { data: unitOne } = useOne({ resource: 'units', id: record?.unit_id, queryOptions: { enabled: !!record?.unit_id } });
  const { data: supplierOne } = useOne({ resource: 'suppliers', id: record?.supplier_id, queryOptions: { enabled: !!record?.supplier_id } });
  const { data: vendorOne } = useOne({ resource: 'vendors', id: record?.vendor_id, queryOptions: { enabled: !!record?.vendor_id } });

  return (
    <Show
      isLoading={isLoading}
      title="Листовой материал"
      headerButtons={canManage ? ({ defaultButtons }) => <>{defaultButtons}</> : () => null}
    >
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>ID</Title><TextField value={record?.sheet_material_type_id} /></Col>
        <Col span={8}><Title level={5}>Название</Title><TextField value={record?.name} /></Col>
        <Col span={8}><Title level={5}>Тип материала</Title><TextField value={typeOne?.data?.material_type_name} /></Col>
        <Col span={8}><Title level={5}>Порядок сортировки</Title><TextField value={record?.sort_order} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Ед. изм.</Title><TextField value={unitOne?.data?.unit_name} /></Col>
        <Col span={8}><Title level={5}>Толщина, мм</Title><TextField value={record?.thickness_mm} /></Col>
        <Col span={8}><Title level={5}>Ширина, мм</Title><TextField value={record?.width_mm} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Высота, мм</Title><TextField value={record?.height_mm} /></Col>
        <Col span={8}><Title level={5}>Поставщик</Title><TextField value={supplierOne?.data?.supplier_name ?? '—'} /></Col>
        <Col span={8}><Title level={5}>Производитель</Title><TextField value={vendorOne?.data?.vendor_name ?? '—'} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Артикул поставщика</Title><TextField value={record?.supplier_article ?? '—'} /></Col>
        <Col span={8}><Title level={5}>Текстура</Title>{record?.texture === null || record?.texture === undefined ? <TextField value="—" /> : <Tag color={record.texture ? 'blue' : 'default'}>{record.texture ? 'Да' : 'Нет'}</Tag>}</Col>
        <Col span={8}><Title level={5}>Цвет</Title><TextField value={record?.color ?? '—'} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Активен</Title><Badge status={record?.is_active ? 'success' : 'default'} text={record?.is_active ? 'Активен' : 'Неактивен'} /></Col>
        <Col span={8}><Title level={5}>Версия</Title><TextField value={record?.version} /></Col>
        <Col span={8}><Title level={5}>Ключ 1C</Title><TextField value={record?.ref_key_1c} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Создан</Title><TextField value={record?.created_by || '—'} /></Col>
        <Col span={8}><Title level={5}>Изменён</Title><TextField value={record?.edited_by || '—'} /></Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={8}><Title level={5}>Создано</Title><DateField value={record?.created_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} /></Col>
        <Col span={8}><Title level={5}>Обновлено</Title><DateField value={record?.updated_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} /></Col>
      </Row>
    </Show>
  );
};
