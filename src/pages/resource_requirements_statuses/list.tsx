import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const ResourceRequirementStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="requirement_status_id">
        <Table.Column dataIndex="requirement_status_id" title="Status ID" sorter />
        <Table.Column dataIndex="requirement_status_code" title="Code" sorter />
        <Table.Column dataIndex="requirement_status_name" title="Name" sorter />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => (value ? "Yes" : "No")}
        />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requirement_status_id} />
              <EditButton hideText size="small" recordItemId={record.requirement_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
