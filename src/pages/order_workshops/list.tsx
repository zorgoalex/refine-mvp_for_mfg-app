import { Table } from '../../ui/tooltipDelay';
import { useMemo } from "react";
import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, DateField } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { useReferenceHeaderFilters } from "../../components/referenceFilters/useReferenceHeaderFilters";
import { Space } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { DISPLAY_DATE_FORMAT, DISPLAY_DATE_TIME_FORMAT } from "../../utils/dateFormat";

const ORDER_WORKSHOPS_HEADER_FILTERS = {
  resource: "order_workshops",
  fields: ["workshop_id", "production_status_id", "sequence_order"],
  lookups: {
    workshop_id: { resource: "workshops", optionValue: "workshop_id", optionLabel: "workshop_name" },
    production_status_id: { resource: "production_statuses", optionValue: "production_status_id", optionLabel: "production_status_name" },
  },
};

export const OrderWorkshopList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_workshop_id", order: "desc" }],
    },
  });
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, ORDER_WORKSHOPS_HEADER_FILTERS);
  const { show } = useNavigation();

  // Пользователи мыслят названиями: подтягиваем имена заказов (паттерн payments/list)
  const orderIds = useMemo(
    () => [...new Set((tableProps.dataSource || []).map((row: any) => row.order_id).filter(Boolean))],
    [tableProps.dataSource],
  );
  const { data: ordersData } = useMany({ resource: "orders", ids: orderIds, queryOptions: { enabled: orderIds.length > 0 } });
  const orderMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (ordersData?.data || []).forEach((o: any) => (map[o.order_id] = o.order_name ?? `#${o.order_id}`));
    return map;
  }, [ordersData]);

  return (
    <LocalizedList title="Заказы по цехам">
      <Table
        {...tableProps}
        rowKey="order_workshop_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_workshops", record.order_workshop_id);
          },
        })}
      >
        <Table.Column dataIndex="order_workshop_id" title="id" sorter />
        <Table.Column dataIndex="order_id" title="Заказ" sorter render={(value) => (value ? orderMap[value] ?? `#${value}` : "—")} />
        <Table.Column dataIndex="workshop_id" {...columnFilter("workshop_id")} title="Цех" sorter />
        <Table.Column dataIndex="production_status_id" {...columnFilter("production_status_id")} title="Статус производства" sorter />
        <Table.Column dataIndex="sequence_order" {...columnFilter("sequence_order")} title="Последовательный номер этапа" sorter />
        <Table.Column
          dataIndex="received_date"
          sorter
          title="Дата поступления в цех"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="started_date"
          sorter
          title="Дата начала работ"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="completed_date"
          sorter
          title="Дата завершения"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          sorter
          title="Плановая дата завершения"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_FORMAT} />}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.order_workshop_id} />
              <EditButton hideText size="small" recordItemId={record.order_workshop_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
