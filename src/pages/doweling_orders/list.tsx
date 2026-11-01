import { Table, Tooltip } from '../../ui/tooltipDelay';
import React, { useMemo, useState } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, List } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Badge, Button, Space } from "antd";
import { EyeOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { can } from "../../utils/permissions";
import { QuickCreateDowelingModal } from "./QuickCreateDowelingModal";
import { useBazisCardsCapability } from "../../hooks/useBazisCardsCapability";
import { useOrderFinancialVisibility } from "../../hooks/useOrderFinancialVisibility";
import { naturalSorter } from "../../utils/naturalSort";
import { DowelingClientLink, DowelingOrderLink } from "./dowelingRecordLinks";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import { applyDowelingFilters, dowelingFilterConfig, type DowelingRow } from "./dowelingListFilters";

export const DowelOrderList: React.FC<IResourceComponentsProps> = () => {
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  // Money columns only with the right and the settings matrix (Hasura answers money only with orders.view_financials).
  const { canViewFinancials } = useOrderFinancialVisibility();
  // The quick-create of a card needs a backend that knows cards (an open tab after a backend rollback hides it).
  const cardsSupported = useBazisCardsCapability();
  // Используем doweling_orders_view - одна строка = одна пара присадка-заказ (через order_doweling_links);
  // standalone присадки (без связи) показываются одной строкой с NULL order-колонками (LEFT JOIN).
  // Search and filters (the «Фильтры» bar) are applied to the loaded rows too (dowelingListFilters.ts): they stay
  // in the URL but are not sent to the server; inactive cards are hidden unless «Показывать неактивные».
  const { tableProps, tableQueryResult, filters, setFilters, setCurrent } = useTable({
    resource: "doweling_orders_view",
    syncWithLocation: true,
    filters: {
      mode: "off",
    },
    // The whole list (a few hundred rows) is loaded and sorted here: numbers of Bazis projects and orders sort
    // naturally («2» before «12», «1347» before «1347-5»), which a text sort on the server cannot do.
    sorters: {
      mode: "off",
    },
    pagination: {
      mode: "client",
      pageSize: 20,
    },
  });

  const { show } = useNavigation();
  const allRows = (tableProps.dataSource ?? []) as DowelingRow[];
  const filterConfig = useMemo(() => dowelingFilterConfig(allRows, canViewFinancials), [allRows, canViewFinancials]);
  const rows = useMemo(() => applyDowelingFilters(allRows, filters), [allRows, filters]);

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
      title="Базис-проекты"
      headerButtons={() => (
        <Space size={12} wrap>
          {can("doweling.create") && cardsSupported ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setQuickCreateOpen(true)}
            >
              Быстрое создание Базис-проекта
            </Button>
          ) : null}
        </Space>
      )}
    >
      <QuickCreateDowelingModal
        open={quickCreateOpen}
        onClose={() => setQuickCreateOpen(false)}
        onCreated={() => {
          void tableQueryResult.refetch();
        }}
      />
      <ReferenceFilterBar
        storageKey="doweling_orders"
        config={filterConfig}
        filters={filters}
        setFilters={setFilters}
        setCurrent={setCurrent}
      />
      <Table
        {...tableProps}
        dataSource={rows}
        rowKey={(record: any) => `${record.doweling_order_id}-${record.order_id}`}
        sticky
        scroll={{ x: "max-content", y: 600 }}
        showSorterTooltip={{ mouseEnterDelay: 1 }}
        pagination={{
          ...tableProps.pagination,
          total: rows.length,
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
          sorter={naturalSorter("doweling_order_id")}
          defaultSortOrder="descend"
          width={60}
          render={(value) => <span style={{ fontSize: '75%' }}>{value}</span>}
        />
        <Table.Column
          dataIndex="doweling_order_name"
          title="Базис-проект"
          sorter={naturalSorter("doweling_order_name")}
          width={100}
          render={(value) => <span style={{ color: '#DC2626', letterSpacing: '0.8px' }}>{value || "—"}</span>}
        />
        <Table.Column
          dataIndex="bazis_xml_count"
          title="XML Базиса"
          width={90}
          render={(value) => (Number(value) > 0 ? `есть (${value})` : "—")}
        />
        <Table.Column
          dataIndex="delete_flag"
          title="Активен"
          sorter={naturalSorter("delete_flag")}
          width={110}
          render={(value) => {
            const active = value !== true;
            return (
              <Badge
                status={active ? "success" : "default"}
                text={active ? "Активен" : "Неактивен"}
              />
            );
          }}
        />
        <Table.Column
          dataIndex="order_name"
          title="Заказ"
          sorter={naturalSorter("order_name")}
          width={100}
          render={(value, record: any) => (
            <DowelingOrderLink
              orderId={record.order_id}
              orderName={value}
              fromLabel="Базис-проекты"
              style={{ color: '#1890ff', letterSpacing: '0.5px' }}
            />
          )}
        />
        <Table.Column
          dataIndex="doweling_order_date"
          title="Дата заказа"
          sorter={naturalSorter("doweling_order_date")}
          width={100}
          render={(value) => formatDate(value)}
        />
        <Table.Column
          dataIndex="client_name"
          title="Клиент"
          width={120}
          render={(value, record: any) => (
            <DowelingClientLink clientId={record.client_id} clientName={value} fromLabel="Базис-проекты" />
          )}
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
          sorter={naturalSorter("parts_count")}
          width={80}
          align="center"
        />
        {canViewFinancials && (
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
        )}
        <Table.Column
          dataIndex="production_status_name"
          title="Статус производства"
          width={100}
          render={(value) => renderStatus(value)}
        />
        {canViewFinancials && [
          <Table.Column
            key="total_amount"
            dataIndex="total_amount"
            title="Сумма"
            sorter={naturalSorter("total_amount")}
            width={90}
            align="right"
            render={(value) => formatNumber(value as number, 0)}
          />,
          <Table.Column
            key="discount"
            dataIndex="discount"
            title="Скидка"
            sorter={naturalSorter("discount")}
            width={70}
            align="right"
            render={(value) => formatNumber(value as number, 0)}
          />,
          <Table.Column
            key="surcharge"
            dataIndex="surcharge"
            title="Наценка"
            sorter={naturalSorter("surcharge")}
            width={93}
            align="right"
            render={(value) => formatNumber(value as number, 0)}
          />,
          <Table.Column
            key="final_amount"
            dataIndex="final_amount"
            title="Итого"
            sorter={naturalSorter("final_amount")}
            width={90}
            align="right"
            render={(value) => formatNumber(value as number, 0)}
          />,
          <Table.Column
            key="paid_amount"
            dataIndex="paid_amount"
            title="Оплачено"
            sorter={naturalSorter("paid_amount")}
            width={90}
            align="right"
            render={(value) => formatNumber(value as number, 0)}
          />,
        ]}
        <Table.Column
          dataIndex="issue_date"
          title="Дата выдачи"
          sorter={naturalSorter("issue_date")}
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
