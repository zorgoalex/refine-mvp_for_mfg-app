import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const UNITS_FILTERS: ReferenceFilterConfig = {
  search: { field: "unit_name", placeholder: "Поиск по названию" },
  fields: [
    { kind: "text", field: "unit_code", label: "Код единицы" },
    { kind: "text", field: "unit_symbol", label: "Обозначение" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const UnitList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: { initial: [{ field: "sort_order", order: "asc" }, { field: "unit_id", order: "asc" }] },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Единицы измерения">
      <ReferenceFilterBar storageKey="units" config={UNITS_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        rowKey="unit_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("units", record.unit_id);
          },
        })}
      >
        <Table.Column dataIndex="unit_id" title="id" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="unit_code" title="Код единицы" sorter />
        <Table.Column dataIndex="unit_name" title="Название" sorter />
        <Table.Column dataIndex="unit_symbol" title="Обозначение единицы" />
        <Table.Column dataIndex="decimals" title="Знаков после запятой" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.unit_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.unit_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
