import React, { useState } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, List } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Button, Space, Table, Tooltip } from "antd";
import { EyeOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { can } from "../../utils/permissions";
import { QuickCreateDowelingModal } from "./QuickCreateDowelingModal";

export const DowelOrderList: React.FC<IResourceComponentsProps> = () => {
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  // Используем doweling_orders_view - одна строка = одна пара присадка-заказ (через order_doweling_links);
  // standalone присадки (без связи) показываются одной строкой с NULL order-колонками (LEFT JOIN).
  const { tableProps, tableQueryResult } = useTable({
    resource: "doweling_orders_view",
    syncWithLocation: true,
    sorters: {
      initial: [
        { field: "doweling_order_id", order: "desc" },
      ],
    },
    pagination: {
      mode: "server",
      pageSize: 20,
    },
  });

  const { show } = useNavigation();

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  const renderStatus = (value?: string | null) => {
    const displayValue = value || "—";
    return (
      <Tooltip title={displayValue} placement="topLeft">
        <span style={{
          maxWidth: 80,
          display: 'inline-block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>
          {displayValue}
        </span>
      </Tooltip>
    );
  };

  return (
    <List
      title="Присадка"
      headerButtons={() =>
        can("doweling.create") ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setQuickCreateOpen(true)}
          >
            Быстрое создание присадки
          </Button>
        ) : null
      }
    >
      <QuickCreateDowelingModal
        open={quickCreateOpen}
        onClose={() => setQuickCreateOpen(false)}
        onCreated={() => {
          void tableQueryResult.refetch();
        }}
      />
      <Table
        {...tableProps}
        rowKey={(record: any) => `${record.doweling_order_id}-${record.order_id}`}
        sticky
        scroll={{ x: "max-content", y: 600 }}
        showSorterTooltip={{ mouseEnterDelay: 1 }}
        pagination={{
          ...tableProps.pagination,
          pageSizeOptions: [10, 20, 25, 50, 100],
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} из ${total}`,
        }}
        onRow={(record) => ({
          onDoubleClick: () => {
            // Navigate via the resource that actually owns the show route
            // ("doweling_orders_view" → /doweling-orders/show/:id). The bare "doweling_orders"
            // resource has no show route, so show(...) silently no-ops (the prior edit handler
            // was broken the same way).
            show("doweling_orders_view", record.doweling_order_id);
          },
        })}
      >
        <Table.Column
          dataIndex="doweling_order_id"
          title="ID"
          sorter
          width={60}
          render={(value) => <span style={{ fontSize: '75%' }}>{value}</span>}
        />
        <Table.Column
          dataIndex="doweling_order_name"
          title="Присадка"
          sorter
          width={100}
          render={(value) => <span style={{ color: '#DC2626', letterSpacing: '0.8px' }}>{value || "—"}</span>}
        />
        <Table.Column
          dataIndex="order_name"
          title="Заказ"
          sorter
          width={100}
          render={(value) => <span style={{ color: '#1890ff', letterSpacing: '0.5px' }}>{value || "—"}</span>}
        />
        <Table.Column
          dataIndex="doweling_order_date"
          title="Дата заказа"
          sorter
          width={100}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="client_name"
          title="Клиент"
          width={120}
        />
        <Table.Column
          dataIndex="design_engineer"
          title="Конструктор"
          width={120}
        />
        <Table.Column
          dataIndex="operator"
          title="Оператор"
          width={120}
        />
        <Table.Column
          dataIndex="material_name"
          title="Материал"
          width={100}
        />
        <Table.Column
          dataIndex="milling_type_name"
          title="Фрезеровка"
          width={100}
        />
        <Table.Column
          dataIndex="edge_type_name"
          title="Обкат"
          width={80}
        />
        <Table.Column
          dataIndex="parts_count"
          title="Кол-во деталей"
          sorter
          width={80}
          align="center"
        />
        <Table.Column
          dataIndex="payment_status_name"
          title="Статус оплаты"
          width={90}
          render={(value) => {
            const displayValue = value || "—";
            let color = undefined;
            if (value === 'Не оплачен') {
              color = '#ff4d4f';
            } else if (value === 'Частично оплачен') {
              color = '#d4a574';
            } else if (value === 'Оплачен') {
              color = '#52c41a';
            }
            return (
              <Tooltip title={displayValue} placement="topLeft">
                <span style={{ ...(color && { color, fontWeight: 500 }) }}>
                  {displayValue}
                </span>
              </Tooltip>
            );
          }}
        />
        <Table.Column
          dataIndex="production_status_name"
          title="Статус производства"
          width={100}
          render={(value) => renderStatus(value)}
        />
        <Table.Column
          dataIndex="total_amount"
          title="Сумма"
          sorter
          width={90}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="discount"
          title="Скидка"
          sorter
          width={70}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="surcharge"
          title="Наценка"
          sorter
          width={93}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="final_amount"
          title="Итого"
          sorter
          width={90}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="paid_amount"
          title="Оплачено"
          sorter
          width={90}
          align="right"
          render={(value) => formatNumber(value as number, 0)}
        />
        <Table.Column
          dataIndex="issue_date"
          title="Дата выдачи"
          sorter
          width={100}
          render={(value) => formatDate(value)}
        />
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
                recordItemId={record.doweling_order_id}
              />
              <EditButton
                hideText
                size="small"
                icon={<EditOutlined style={{ fontSize: 12 }} />}
                recordItemId={record.doweling_order_id}
              />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
