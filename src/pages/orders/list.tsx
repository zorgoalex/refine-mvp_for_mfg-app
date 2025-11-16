import React, { useMemo, useState } from "react";
import {
  IResourceComponentsProps,
  useMany,
  useNavigation,
} from "@refinedev/core";
import {
  List,
  useTable,
  ShowButton,
  EditButton,
  CreateButton,
} from "@refinedev/antd";
import { Space, Table, Button } from "antd";
import { EyeOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";

import { formatNumber } from "../../utils/numberFormat";
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
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  const renderStatus = (value?: string | null) => (
    <span className="orders-status-value">{value || "—"}</span>
  );

  const createdByIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.created_by)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const { data: usersData } = useMany({
    resource: "users",
    ids: createdByIds,
    queryOptions: { enabled: createdByIds.length > 0 },
  });

  const createdByMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (usersData?.data || []).forEach((u: any) => {
      map[u.user_id] = u.username;
    });
    return map;
  }, [usersData]);

  return (
    <>
      <List
        title="Заказы"
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
          scroll={{ x: "max-content", y: 600 }}
          onRow={(record) => ({
            onDoubleClick: () => {
              show("orders_view", record.order_id);
            },
          })}
        >
          <Table.Column
            dataIndex="order_id"
            title="ID заказа"
            sorter
            width={80}
            className="col-order-id"
            onHeaderCell={() => ({ className: "col-order-id" })}
          />
          <Table.Column
            dataIndex="order_name"
            title="Заказ"
            sorter
            width={120}
            className="orders-col narrow"
          />
          <Table.Column
            dataIndex="order_date"
            title="Дата заказа"
            sorter
            width={100}
            className="orders-col"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="client_name"
            title="Имя клиента"
            width={140}
            className="orders-col"
          />
          <Table.Column
            dataIndex="milling_type_name"
            title="Фрезеровка"
            width={120}
            className="orders-col"
          />
          <Table.Column
            dataIndex="material_name"
            title="Материал"
            width={120}
            className="orders-col"
          />
          <Table.Column
            dataIndex="priority"
            title="Приоритет заказа"
            sorter
            width={80}
            className="col-priority"
            onHeaderCell={() => ({ className: "col-priority" })}
          />
          <Table.Column
            dataIndex="completion_date"
            title="Дата выполнения"
            sorter
            width={110}
            className="orders-col"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="planned_completion_date"
            title="Планируемая дата выполнения"
            sorter
            width={140}
            className="orders-col"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="order_status_name"
            title="Статус заказа"
            width={120}
            className="orders-col status order-status"
            render={(value) => renderStatus(value)}
          />
          <Table.Column
            dataIndex="payment_status_name"
            title="Статус оплаты заказа"
            width={140}
            className="orders-col status payment-status"
            render={(value) => renderStatus(value)}
          />
          <Table.Column
            dataIndex="issue_date"
            title="Дата выдачи заказа"
            sorter
            width={120}
            className="orders-col"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="total_amount"
            title="Сумма заказа"
            sorter
            width={110}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="discounted_amount"
            title="Сумма со скидкой"
            sorter
            width={120}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="discount"
            title="Скидка"
            sorter
            width={80}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="paid_amount"
            title="Сумма оплаты"
            sorter
            width={110}
            className="orders-col"
            render={(value) => formatNumber(value as number, 0)}
          />
          <Table.Column
            dataIndex="payment_date"
            title="Дата оплаты заказа"
            sorter
            width={130}
            className="orders-col"
            render={(value) => formatDate(value)}
          />
          <Table.Column
            dataIndex="notes"
            title="Примечание"
            width={160}
            className="orders-col"
          />
          <Table.Column
            dataIndex="parts_count"
            title="Количество деталей"
            sorter
            width={130}
            className="orders-col"
          />
          <Table.Column
            dataIndex="total_area"
            title="Площадь заказа"
            sorter
            width={110}
            className="orders-col"
          />
          <Table.Column
            dataIndex="edge_type_name"
            title="Обкат"
            width={100}
            className="orders-col"
          />
          <Table.Column
            dataIndex="film_name"
            title="Пленка"
            width={140}
            className="orders-col"
          />
          <Table.Column
            dataIndex="created_by"
            title="Создано"
            width={120}
            className="orders-col"
            render={(_, record: any) =>
              createdByMap[record?.created_by] ?? record?.created_by
            }
          />
          <Table.Column
            title="Действия"
            width={100}
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
