import { IResourceComponentsProps, useMany } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useMemo } from "react";

export const MaterialList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  const typeIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.material_type_id)
            .filter((v) => v !== undefined && v !== null)
        )
      ),
    [tableProps?.dataSource]
  );
  const vendorIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.vendor_id)
            .filter((v) => v !== undefined && v !== null)
        )
      ),
    [tableProps?.dataSource]
  );
  const supplierIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.default_supplier_id)
            .filter((v) => v !== undefined && v !== null)
        )
      ),
    [tableProps?.dataSource]
  );

  const { data: typesData } = useMany({ resource: "material_types", ids: typeIds, queryOptions: { enabled: typeIds.length > 0 } });
  const { data: vendorsData } = useMany({ resource: "vendors", ids: vendorIds, queryOptions: { enabled: vendorIds.length > 0 } });
  const { data: suppliersData } = useMany({ resource: "suppliers", ids: supplierIds, queryOptions: { enabled: supplierIds.length > 0 } });

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => (map[t.material_type_id] = t.material_type_name));
    return map;
  }, [typesData]);
  const vendorMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (vendorsData?.data || []).forEach((v: any) => (map[v.vendor_id] = v.vendor_name));
    return map;
  }, [vendorsData]);
  const supplierMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (suppliersData?.data || []).forEach((s: any) => (map[s.supplier_id] = s.name));
    return map;
  }, [suppliersData]);

  return (
    <List>
      <Table {...tableProps} rowKey="material_id">
        <Table.Column dataIndex="material_id" title="Material ID" sorter />
        <Table.Column dataIndex="material_name" title="Name" sorter />
        <Table.Column dataIndex="unit" title="Unit" />
        <Table.Column dataIndex="material_type_id" title="Material Type" render={(_, r: any) => typeMap[r?.material_type_id] ?? r?.material_type_id} />
        <Table.Column dataIndex="vendor_id" title="Vendor" render={(_, r: any) => vendorMap[r?.vendor_id] ?? r?.vendor_id} />
        <Table.Column dataIndex="default_supplier_id" title="Supplier" render={(_, r: any) => supplierMap[r?.default_supplier_id] ?? r?.default_supplier_id} />
        <Table.Column dataIndex="description" title="Description" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.material_id} />
              <EditButton hideText size="small" recordItemId={record.material_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
