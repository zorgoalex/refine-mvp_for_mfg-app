import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import dayjs from "dayjs";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_id", order: "desc" }],
    },
    pagination: {
      pageSize: 10,
    },
  });
  const { show } = useNavigation();

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="order_id"
        sticky
        scroll={{ x: 'max-content', y: 600 }}
        onRow={(record) => ({
          onDoubleClick: () => {
            show("orders_view", record.order_id);
          },
        })}
      >
        <Table.Column dataIndex="order_id" title="Order ID" sorter width={160} />
        <Table.Column dataIndex="order_name" title="Order Name" sorter width={400} />
        <Table.Column
          dataIndex="order_date"
          title="Order Date"
          sorter
          width={200}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="client_name" title="Client" width={300} />
        <Table.Column dataIndex="milling_type_name" title="Milling Type" width={240} />
        <Table.Column dataIndex="material_name" title="Material" width={240} />
        <Table.Column dataIndex="film_name" title="Film" width={300} />
        <Table.Column dataIndex="priority" title="Priority" sorter width={160} />
        <Table.Column
          dataIndex="completion_date"
          title="Completion Date"
          sorter
          width={240}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          title="Planned Completion"
          sorter
          width={260}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="order_status_name" title="Order Status" width={220} />
        <Table.Column dataIndex="payment_status_name" title="Payment Status" width={240} />
        <Table.Column
          dataIndex="issue_date"
          title="Issue Date"
          sorter
          width={200}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="total_amount" title="Total Amount" sorter width={220} />
        <Table.Column dataIndex="discounted_amount" title="Discounted Amount" sorter width={280} />
        <Table.Column dataIndex="discount" title="Discount" sorter width={160} />
        <Table.Column dataIndex="paid_amount" title="Paid Amount" sorter width={220} />
        <Table.Column
          dataIndex="payment_date"
          title="Payment Date"
          sorter
          width={200}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="notes" title="Notes" width={400} />
        <Table.Column dataIndex="parts_count" title="Parts Count" sorter width={200} />
        <Table.Column dataIndex="total_area" title="Total Area" sorter width={200} />
        <Table.Column dataIndex="edge_type_name" title="Edge Type" width={200} />
        <Table.Column
          title="Actions"
          width={160}
          fixed="right"
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
