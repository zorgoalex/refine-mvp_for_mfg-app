import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton } from "@refinedev/antd";
import { ReferenceEditButton } from "../../components/referenceDrawer/ReferenceEditButton";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { useReferenceHeaderFilters } from "../../components/referenceFilters/useReferenceHeaderFilters";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const TRANSACTION_DIRECTION_FILTERS: ReferenceFilterConfig = {
  search: { field: "direction_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "direction_code", label: "Код направления" },
    { kind: "text", field: "description", label: "Описание" },
  ],
};

const TRANSACTION_DIRECTION_HEADER_FILTERS = {
  resource: "transaction_direction",
  fields: ["direction_code", "direction_name", "description"],
};

export const TransactionDirectionList: React.FC<
  IResourceComponentsProps
> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "direction_type_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, TRANSACTION_DIRECTION_HEADER_FILTERS);
  const { show } = useNavigation();

  return (
    <LocalizedList title="Направления движения">
      <ReferenceFilterBar storageKey="transaction_direction" config={TRANSACTION_DIRECTION_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        rowKey="direction_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("transaction_direction", record.direction_type_id);
          },
        })}
      >
        <Table.Column dataIndex="direction_type_id" title="ID" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="direction_code" {...columnFilter("direction_code")} title="Код направления" sorter />
        <Table.Column dataIndex="direction_name" {...columnFilter("direction_name")} title="Название направления" sorter />
        <Table.Column dataIndex="description" sorter {...columnFilter("description")} title="Описание" />
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
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.direction_type_id}
              />
              <ReferenceEditButton
                hideText
                size="small"
                recordItemId={record.direction_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
