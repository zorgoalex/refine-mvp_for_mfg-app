import { Table } from '../../ui/tooltipDelay';
import { useMemo } from "react";
import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, DateField } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { DISPLAY_DATE_FORMAT, DISPLAY_DATE_TIME_FORMAT } from "../../utils/dateFormat";

export const OrderWorkshopList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_workshop_id", order: "desc" }],
    },
  });
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
        <Table.Column dataIndex="workshop_id" title="Цех" sorter />
        <Table.Column dataIndex="production_status_id" title="Статус производства" sorter />
        <Table.Column dataIndex="sequence_order" title="Последовательный номер этапа" sorter />
        <Table.Column
          dataIndex="received_date"
          title="Дата поступления в цех"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="started_date"
          title="Дата начала работ"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="completed_date"
          title="Дата завершения"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          dataIndex="planned_completion_date"
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
