import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

const MILLING_TYPES_FILTERS: ReferenceFilterConfig = {
  search: { field: "milling_type_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "range", field: "cost_per_sqm", label: "Стоимость за м²" },
    { kind: "text", field: "description", label: "Описание" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const MillingTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "milling_type_id", order: "asc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "milling_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы фрезеровок">
      <ReferenceFilterBar storageKey="milling_types" config={MILLING_TYPES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="milling_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("milling_types", record.milling_type_id);
          },
        })}
      >
        <Table.Column dataIndex="milling_type_id" title="id" sorter />
        <Table.Column dataIndex="milling_type_name" title="Тип фрезеровки" sorter />
        <Table.Column
          dataIndex="cost_per_sqm"
          title="Стоимость за м²"
        />
        <Table.Column
          title="Минимальные размеры детали"
          render={(_, record: any) => {
            const width = record.min_width_mm ?? '—';
            const height = record.min_height_mm ?? '—';
            return `${width} × ${height} мм`;
          }}
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
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.milling_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.milling_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
