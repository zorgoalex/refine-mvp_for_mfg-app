import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { EyeOutlined, EditOutlined } from "@ant-design/icons";
import { formatNumber } from "../../utils/numberFormat";
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
        className="orders-table"
        scroll={{ x: 'max-content', y: 600 }}
        onRow={(record) => ({
          onDoubleClick: () => {
            show("orders_view", record.order_id);
          },
        })}
      >
        <Table.Column
          dataIndex="order_id"
          title="Order ID"
          sorter
          width={80}
          className="col-order-id"
          onHeaderCell={() => ({ className: 'col-order-id' })}
        />
        <Table.Column dataIndex="order_name" title="Order Name" sorter width={67} />
        <Table.Column
          dataIndex="order_date"
          title="Order Date"
          sorter
          width={100}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="client_name" title="Client" width={126} />
        <Table.Column dataIndex="milling_type_name" title="Milling Type" width={90} />
        <Table.Column dataIndex="material_name" title="Material" width={96} />
        <Table.Column
          dataIndex="priority"
          title="П"
          sorter
          width={48}
          className="col-priority"
          onHeaderCell={() => ({ className: 'col-priority' })}
        />
        <Table.Column
          dataIndex="completion_date"
          title="Completion Date"
          sorter
          width={120}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          title="Planned Completion"
          sorter
          width={104}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="order_status_name" title="Order Status" width={110} />
        <Table.Column dataIndex="payment_status_name" title="Payment Status" width={120} />
        <Table.Column
          dataIndex="issue_date"
          title="Issue Date"
          sorter
          width={100}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="total_amount"
          title="Total Amount"
          sorter
          width={110}
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="discounted_amount"
          title="Discounted Amount"
          sorter
          width={112}
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="discount"
          title="Discount"
          sorter
          width={80}
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="paid_amount"
          title="Paid Amount"
          sorter
          width={110}
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="payment_date"
          title="Payment Date"
          sorter
          width={100}
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="notes" title="Notes" width={140} />
        <Table.Column dataIndex="parts_count" title="Parts Count" sorter width={100} />
        <Table.Column dataIndex="total_area" title="Total Area" sorter width={80} />
        <Table.Column dataIndex="edge_type_name" title="Edge Type" width={80} />
        <Table.Column dataIndex="film_name" title="Film" width={150} />
        <Table.Column
          title="Actions"
          width={80}
          fixed="right"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                icon={<EyeOutlined style={{ fontSize: 12 }} />}
                recordItemId={record.order_id}
              />
              <EditButton
                hideText
                size="small"
                icon={<EditOutlined style={{ fontSize: 12 }} />}
                recordItemId={record.order_id}
              />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
