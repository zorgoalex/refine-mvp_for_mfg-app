import React, { useMemo } from 'react';
import { IResourceComponentsProps, useMany, useNavigation } from '@refinedev/core';
import { useTable, ShowButton, EditButton, CreateButton } from '@refinedev/antd';
import { Space, Table, Badge, Tag, Button } from 'antd';
import { useHighlightRow } from '../../hooks/useHighlightRow';
import { LocalizedList } from '../../components/LocalizedList';
import { can } from '../../utils/permissions';

export const SheetMaterialList: React.FC<IResourceComponentsProps> = () => {
  const canManage = can('sheet_materials.manage');
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: { initial: [{ field: 'sheet_material_type_id', order: 'desc' }] },
  });
  const { highlightProps } = useHighlightRow('sheet_material_type_id', tableProps.dataSource);
  const { show } = useNavigation();

  const typeIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.material_type_id).filter(Boolean))),
    [tableProps?.dataSource],
  );
  const unitIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.unit_id).filter(Boolean))),
    [tableProps?.dataSource],
  );
  const supplierIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.supplier_id).filter(Boolean))),
    [tableProps?.dataSource],
  );
  const vendorIds = useMemo(
    () => Array.from(new Set(((tableProps?.dataSource as any[]) || []).map((i) => i?.vendor_id).filter(Boolean))),
    [tableProps?.dataSource],
  );

  const { data: typesData } = useMany({ resource: 'material_types', ids: typeIds, queryOptions: { enabled: typeIds.length > 0 } });
  const { data: unitsData } = useMany({ resource: 'units', ids: unitIds, queryOptions: { enabled: unitIds.length > 0 } });
  const { data: suppliersData } = useMany({ resource: 'suppliers', ids: supplierIds, queryOptions: { enabled: supplierIds.length > 0 } });
  const { data: vendorsData } = useMany({ resource: 'vendors', ids: vendorIds, queryOptions: { enabled: vendorIds.length > 0 } });

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => { map[t.material_type_id] = t.material_type_name; });
    return map;
  }, [typesData]);
  const unitMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (unitsData?.data || []).forEach((u: any) => { map[u.unit_id] = u.unit_name; });
    return map;
  }, [unitsData]);
  const supplierMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (suppliersData?.data || []).forEach((s: any) => { map[s.supplier_id] = s.supplier_name; });
    return map;
  }, [suppliersData]);
  const vendorMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (vendorsData?.data || []).forEach((v: any) => { map[v.vendor_id] = v.vendor_name; });
    return map;
  }, [vendorsData]);

  return (
    <LocalizedList
      title="Листовые материалы"
      headerButtons={canManage ? <CreateButton resource="sheet_material_types" /> : undefined}
    >
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="sheet_material_type_id"
        onRow={(record) => ({ onDoubleClick: () => show('sheet_material_types', record.sheet_material_type_id) })}
      >
        <Table.Column dataIndex="sheet_material_type_id" title="ID" sorter />
        <Table.Column dataIndex="name" title="Название" sorter />
        <Table.Column
          dataIndex="material_type_id"
          title="Тип материала"
          render={(_, record: any) => typeMap[record?.material_type_id] ?? record?.material_type_id}
        />
        <Table.Column
          dataIndex="unit_id"
          title="Ед. изм."
          render={(_, record: any) => unitMap[record?.unit_id] ?? record?.unit_id}
        />
        <Table.Column dataIndex="thickness_mm" title="Толщина, мм" sorter />
        <Table.Column dataIndex="width_mm" title="Ширина, мм" />
        <Table.Column dataIndex="height_mm" title="Высота, мм" />
        <Table.Column
          dataIndex="supplier_id"
          title="Поставщик"
          render={(_, record: any) => supplierMap[record?.supplier_id] ?? (record?.supplier_id ? record.supplier_id : '—')}
        />
        <Table.Column
          dataIndex="vendor_id"
          title="Производитель"
          render={(_, record: any) => vendorMap[record?.vendor_id] ?? (record?.vendor_id ? record.vendor_id : '—')}
        />
        <Table.Column dataIndex="supplier_article" title="Артикул" render={(v) => v ?? '—'} />
        <Table.Column
          dataIndex="texture"
          title="Текстура"
          render={(v) => (v === null || v === undefined ? '—' : v ? <Tag color="blue">Да</Tag> : <Tag>Нет</Tag>)}
        />
        <Table.Column dataIndex="color" title="Цвет" render={(v) => v ?? '—'} />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          sorter
          render={(value: boolean) => <Badge status={value ? 'success' : 'default'} text={value ? 'Активен' : 'Неактивен'} />}
          filters={[{ text: 'Активен', value: true }, { text: 'Неактивен', value: false }]}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton hideText size="small" recordItemId={record.sheet_material_type_id} />
              {canManage && <EditButton hideText size="small" recordItemId={record.sheet_material_type_id} />}
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
