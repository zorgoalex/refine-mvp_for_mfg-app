import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";

const EDGE_TYPE_FILTERS: ReferenceFilterConfig = {
  search: { field: "edge_type_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const EdgeTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "edge_type_id", order: "asc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "edge_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы обката">
      <ReferenceFilterBar storageKey="edge_types" config={EDGE_TYPE_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="edge_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("edge_types", record.edge_type_id);
          },
        })}
      >
        <Table.Column dataIndex="edge_type_id" title="id" sorter />
        <Table.Column dataIndex="edge_type_name" title="Тип обката" sorter />
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
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.edge_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.edge_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
