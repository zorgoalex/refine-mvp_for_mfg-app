import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Tag } from "antd";

export const TransactionDirectionList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="direction_type_id">
        <Table.Column dataIndex="direction_type_id" title="ID" sorter />
        <Table.Column dataIndex="direction_code" title="Code" sorter />
        <Table.Column dataIndex="direction_name" title="Name" sorter />
        <Table.Column dataIndex="description" title="Description" />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => <Tag color={value ? "success" : "default"}>{value ? "Yes" : "No"}</Tag>}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.direction_type_id} />
              <EditButton hideText size="small" recordItemId={record.direction_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
