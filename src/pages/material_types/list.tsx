import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

const MATERIAL_TYPES_FILTERS: ReferenceFilterConfig = {
  search: { field: "material_type_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "description", label: "Описание" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const MaterialTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "material_type_id", order: "asc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "material_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы материалов">
      <ReferenceFilterBar storageKey="material_types" config={MATERIAL_TYPES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="material_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("material_types", record.material_type_id);
          },
        })}
      >
        <Table.Column dataIndex="material_type_id" title="id" sorter />
        <Table.Column
          dataIndex="material_type_name"
          title="Тип материала"
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
        <Table.Column dataIndex="description" title="Описание" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.material_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.material_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
