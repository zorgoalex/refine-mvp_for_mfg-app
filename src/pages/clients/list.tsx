import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="client_id">
        <Table.Column dataIndex="client_id" title="Client ID" sorter />
        <Table.Column dataIndex="client_name" title="Name" sorter />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.client_id} />
              <EditButton hideText size="small" recordItemId={record.client_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
