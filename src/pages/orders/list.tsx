import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="order_id">
        <Table.Column dataIndex="order_id" title="Order ID" sorter />
        <Table.Column dataIndex="order_name" title="Order Name" sorter />
        <Table.Column dataIndex="order_date" title="Order Date" sorter />
        <Table.Column dataIndex="client_name" title="Client" />
        <Table.Column dataIndex="milling_type_name" title="Milling Type" />
        <Table.Column dataIndex="material_name" title="Material" />
        <Table.Column dataIndex="film_name" title="Film" />
        <Table.Column dataIndex="total_amount" title="Total Amount" sorter />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.order_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
