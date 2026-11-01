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

const PAYMENT_TYPES_FILTERS: ReferenceFilterConfig = {
  search: { field: "type_paid_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

const PAYMENT_TYPES_HEADER_FILTERS = {
  resource: "payment_types",
  fields: ["type_paid_name", "ref_key_1c"],
};

export const PaymentTypeList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "type_paid_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, PAYMENT_TYPES_HEADER_FILTERS);
  const { highlightProps } = useHighlightRow(
    "type_paid_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы оплаты">
      <ReferenceFilterBar storageKey="payment_types" config={PAYMENT_TYPES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="type_paid_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("payment_types", record.type_paid_id);
          },
        })}
      >
        <Table.Column dataIndex="type_paid_id" title="id" sorter />
        <Table.Column
          dataIndex="type_paid_name"
          {...columnFilter("type_paid_name")}
          title="Тип оплаты"
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
        <Table.Column dataIndex="ref_key_1c" sorter {...columnFilter("ref_key_1c")} title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.type_paid_id}
              />
              <ReferenceEditButton
                hideText
                size="small"
                recordItemId={record.type_paid_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
