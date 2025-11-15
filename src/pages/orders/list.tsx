import React, { useState } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton, CreateButton } from "@refinedev/antd";
import { Space, Table, Button } from "antd";
import { EyeOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { formatNumber } from "../../utils/numberFormat";
import dayjs from "dayjs";
import { OrderCreateModal } from "./components/OrderCreateModal";
import "./list.css";

export const OrderList: React.FC<IResourceComponentsProps> = () => {
  const [createModalOpen, setCreateModalOpen] = useState(false);

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

  const renderStatus = (value?: string | null) => (
    <span className="orders-status-value">{value || '—'}</span>
  );

  return (
    <>
      <List
        headerButtons={({ createButtonProps }) => (
          <>
            {createButtonProps && (
              <CreateButton {...createButtonProps}>Создать</CreateButton>
            )}
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateModalOpen(true)}
            >
              Создать заказ
            </Button>
          </>
        )}
      >
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
        <Table.Column dataIndex="order_name" title="Order Name" sorter width={60} className="orders-col narrow" />
        <Table.Column
          dataIndex="order_date"
          title="Order Date"
          sorter
          width={80}
          className="orders-col"
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="client_name" title="Client" width={100} className="orders-col" />
        <Table.Column dataIndex="milling_type_name" title="Milling Type" width={90} className="orders-col" />
        <Table.Column dataIndex="material_name" title="Material" width={90} className="orders-col" />
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
          width={90}
          className="orders-col"
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          title="Planned Completion"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="order_status_name"
          title="Order Status"
          width={90}
          className="orders-col status order-status"
          render={(value) => renderStatus(value)}
        />
        <Table.Column
          dataIndex="payment_status_name"
          title="Payment Status"
          width={90}
          className="orders-col status payment-status"
          render={(value) => renderStatus(value)}
        />
        <Table.Column
          dataIndex="issue_date"
          title="Issue Date"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="total_amount"
          title="Total Amount"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="discounted_amount"
          title="Discounted Amount"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="discount"
          title="Discount"
          sorter
          width={70}
          className="orders-col"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="paid_amount"
          title="Paid Amount"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="payment_date"
          title="Payment Date"
          sorter
          width={90}
          className="orders-col"
          render={(value) => formatDate(value)}
        />
        <Table.Column dataIndex="notes" title="Notes" width={120} className="orders-col" />
        <Table.Column dataIndex="parts_count" title="Parts Count" sorter width={80} className="orders-col" />
        <Table.Column dataIndex="total_area" title="Total Area" sorter width={70} className="orders-col" />
        <Table.Column dataIndex="edge_type_name" title="Edge Type" width={70} className="orders-col" />
        <Table.Column dataIndex="film_name" title="Film" width={120} className="orders-col" />
        <Table.Column
          title="Действия"
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

    <OrderCreateModal
      open={createModalOpen}
      onClose={() => setCreateModalOpen(false)}
    />
    </>
  );
};
