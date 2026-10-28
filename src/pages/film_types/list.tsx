import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
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

export const FilmTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "film_type_id", order: "asc" }],
    },
  });

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
        <Table.Column dataIndex="film_type_name" title="Тип плёнки" sorter />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
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
              <EditButton
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
