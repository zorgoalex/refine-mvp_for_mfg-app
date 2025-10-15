import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const MaterialList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="material_id">
        <Table.Column dataIndex="material_id" title="Material ID" sorter />
        <Table.Column dataIndex="material_name" title="Name" sorter />
        <Table.Column dataIndex="unit" title="Unit" />
        <Table.Column dataIndex="material_type_id" title="Material Type ID" />
        <Table.Column dataIndex="vendor_id" title="Vendor ID" />
        <Table.Column dataIndex="default_supplier_id" title="Supplier ID" />
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
