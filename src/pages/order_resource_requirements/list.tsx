import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table } from "antd";

export const OrderResourceRequirementList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="requirement_id">
        <Table.Column dataIndex="requirement_id" title="ID" sorter />
        <Table.Column dataIndex="order_id" title="Order ID" sorter />
        <Table.Column dataIndex="resource_type" title="Resource Type" sorter />
        <Table.Column dataIndex="material_id" title="Material ID" />
        <Table.Column dataIndex="film_id" title="Film ID" />
        <Table.Column dataIndex="edge_type_id" title="Edge Type ID" />
        <Table.Column dataIndex="required_quantity" title="Required Qty" sorter />
        <Table.Column dataIndex="final_quantity" title="Final Qty" sorter />
        <Table.Column dataIndex="unit_id" title="Unit ID" />
        <Table.Column dataIndex="requirement_status_id" title="Status ID" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => (value ? "Yes" : "No")}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requirement_id} />
              <EditButton hideText size="small" recordItemId={record.requirement_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
