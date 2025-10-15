import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const VendorList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="vendor_id">
        <Table.Column dataIndex="vendor_id" title="Vendor ID" sorter />
        <Table.Column dataIndex="vendor_name" title="Name" sorter />
        <Table.Column dataIndex="contact_info" title="Contact Info" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.vendor_id} />
              <EditButton hideText size="small" recordItemId={record.vendor_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

