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
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const FILM_TYPES_FILTERS: ReferenceFilterConfig = {
  search: { field: "film_type_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

const FILM_TYPES_HEADER_FILTERS = {
  resource: "film_types",
  fields: ["film_type_name", "ref_key_1c"],
};

export const FilmTypeList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "film_type_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, FILM_TYPES_HEADER_FILTERS);

  const { highlightProps } = useHighlightRow(
    "film_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы плёнки">
      <ReferenceFilterBar storageKey="film_types" config={FILM_TYPES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="film_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("film_types", record.film_type_id);
          },
        })}
      >
        <Table.Column dataIndex="film_type_id" title="id" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="film_type_name" {...columnFilter("film_type_name")} title="Тип плёнки" sorter />
        <Table.Column dataIndex="ref_key_1c" sorter {...columnFilter("ref_key_1c")} title="1C-key" />
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
                recordItemId={record.film_type_id}
              />
              <ReferenceEditButton
                hideText
                size="small"
                recordItemId={record.film_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
