import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton } from "@refinedev/antd";
import { ReferenceEditButton } from "../../components/referenceDrawer/ReferenceEditButton";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { useReferenceHeaderFilters } from "../../components/referenceFilters/useReferenceHeaderFilters";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { StatusColorSwatch } from "../../components/StatusColor";

const ORDER_STATUSES_FILTERS: ReferenceFilterConfig = {
  search: { field: "order_status_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "color", label: "Цвет" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

const ORDER_STATUSES_HEADER_FILTERS = {
  resource: "order_statuses",
  fields: ["order_status_name", "color", "ref_key_1c"],
};

export const OrderStatusList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "order_status_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, ORDER_STATUSES_HEADER_FILTERS);

  const { highlightProps } = useHighlightRow(
    "order_status_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Статусы заказов">
      <ReferenceFilterBar storageKey="order_statuses" config={ORDER_STATUSES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="order_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_statuses", record.order_status_id);
          },
        })}
      >
        <Table.Column dataIndex="order_status_id" title="id" sorter />
        <Table.Column
          dataIndex="order_status_name"
          {...columnFilter("order_status_name")}
          title="Статус заказа"
          sorter
        />
        <Table.Column
          dataIndex="sort_order"
          title="Сортировка по умолчанию"
          sorter
        />
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
        />
        <Table.Column
          dataIndex="color"
          sorter
          {...columnFilter("color")}
          title="Цвет статуса"
          align="center"
          render={(value: string | null) => <StatusColorSwatch value={value} />}
        />
        <Table.Column dataIndex="ref_key_1c" sorter {...columnFilter("ref_key_1c")} title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.order_status_id}
              />
              <ReferenceEditButton
                hideText
                size="small"
                recordItemId={record.order_status_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
