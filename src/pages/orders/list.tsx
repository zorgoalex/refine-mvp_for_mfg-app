import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="order_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("orders_view", record.order_id);
          },
        })}
      >
        <Table.Column dataIndex="order_id" title="Order ID" sorter />
        <Table.Column dataIndex="order_name" title="Order Name" sorter />
        <Table.Column dataIndex="order_date" title="Order Date" sorter />
        <Table.Column dataIndex="client_name" title="Client" />
        <Table.Column dataIndex="milling_type_name" title="Milling Type" />
        <Table.Column dataIndex="material_name" title="Material" />
        <Table.Column dataIndex="film_name" title="Film" />
        <Table.Column dataIndex="priority" title="Priority" sorter />
        <Table.Column dataIndex="completion_date" title="Completion Date" sorter />
        <Table.Column dataIndex="planned_completion_date" title="Planned Completion" sorter />
        <Table.Column dataIndex="order_status_name" title="Order Status" />
        <Table.Column dataIndex="payment_status_name" title="Payment Status" />
        <Table.Column dataIndex="issue_date" title="Issue Date" sorter />
        <Table.Column dataIndex="total_amount" title="Total Amount" sorter />
        <Table.Column dataIndex="discounted_amount" title="Discounted Amount" sorter />
        <Table.Column dataIndex="discount" title="Discount" sorter />
        <Table.Column dataIndex="paid_amount" title="Paid Amount" sorter />
        <Table.Column dataIndex="payment_date" title="Payment Date" sorter />
        <Table.Column dataIndex="notes" title="Notes" />
        <Table.Column dataIndex="parts_count" title="Parts Count" sorter />
        <Table.Column dataIndex="total_area" title="Total Area" sorter />
        <Table.Column dataIndex="edge_type_name" title="Edge Type" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.order_id} />
              <EditButton hideText size="small" recordItemId={record.order_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
