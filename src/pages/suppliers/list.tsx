import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const SupplierList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="supplier_id">
        <Table.Column dataIndex="supplier_id" title="Supplier ID" sorter />
        <Table.Column dataIndex="name" title="Name" sorter />
        <Table.Column dataIndex="address" title="Address" />
        <Table.Column dataIndex="contact_person" title="Contact Person" />
        <Table.Column dataIndex="phone" title="Phone" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.supplier_id} />
              <EditButton hideText size="small" recordItemId={record.supplier_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

