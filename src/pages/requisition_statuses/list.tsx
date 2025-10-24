import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const RequisitionStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="requisition_status_id">
        <Table.Column dataIndex="requisition_status_id" title="ID" sorter />
        <Table.Column dataIndex="requisition_status_name" title="Name" sorter />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => (value ? "Yes" : "No")}
        />
        <Table.Column dataIndex="description" title="Description" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requisition_status_id} />
              <EditButton hideText size="small" recordItemId={record.requisition_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
