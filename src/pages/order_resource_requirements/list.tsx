import { useMemo } from "react";
import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, DateField } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { OrderDeletedTag, orderDeletedReferenceClassName } from "../../components/OrderDeletedTag";

export const OrderResourceRequirementList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "requirement_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("requirement_id", tableProps.dataSource);
  const { show } = useNavigation();

  // Пользователи мыслят названиями: подтягиваем имена заказов (паттерн payments/list)
  const orderIds = useMemo(
    () => [...new Set((tableProps.dataSource || []).map((row: any) => row.order_id).filter(Boolean))],
    [tableProps.dataSource],
  );
  const { data: ordersData } = useMany({ resource: "orders", ids: orderIds, queryOptions: { enabled: orderIds.length > 0 } });
  const orderMap = useMemo(() => {
    const map: Record<string | number, { label: string; deleted: boolean }> = {};
    (ordersData?.data || []).forEach((o: any) => {
      map[o.order_id] = { label: o.order_name ?? `#${o.order_id}`, deleted: o.delete_flag === true };
    });
    return map;
  }, [ordersData]);

  return (
    <LocalizedList title="Потребности заказов в ресурсах">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="requirement_id"
        rowClassName={(record: any) =>
          orderDeletedReferenceClassName(
            orderMap[record?.order_id]?.deleted,
            highlightProps.rowClassName(record),
          )
        }
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_resource_requirements", record.requirement_id);
          },
        })}
      >
        <Table.Column dataIndex="requirement_id" title="id" sorter />
        <Table.Column
          dataIndex="order_id"
          title="Заказ"
          sorter
          render={(value) => {
            if (!value) return "—";
            const order = orderMap[value];
            return (
              <Space size={4} wrap>
                <span>{order?.label ?? `#${value}`}</span>
                <OrderDeletedTag deleted={order?.deleted} />
              </Space>
            );
          }}
        />
        <Table.Column dataIndex="resource_type" title="Тип ресурса" sorter />
        <Table.Column dataIndex="material_id" title="Материал" />
        <Table.Column dataIndex="film_id" title="Пленка" />
        <Table.Column dataIndex="edge_type_id" title="Обкат" />
        <Table.Column dataIndex="required_quantity" title="Количество" sorter />
        <Table.Column dataIndex="final_quantity" title="Итоговое количество" sorter />
        <Table.Column dataIndex="unit_id" title="Единица" />
        <Table.Column dataIndex="requirement_status_id" title="Статус потребности" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          sorter
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Активен" : "Неактивен"}
            />
          )}
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requirement_id} />
              <EditButton hideText size="small" recordItemId={record.requirement_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
