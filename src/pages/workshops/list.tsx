import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { LocalizedList } from "../../components/LocalizedList";
import { Space, Badge } from "antd";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const WORKSHOPS_FILTERS: ReferenceFilterConfig = {
  search: { field: "workshop_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "address", label: "Адрес" },
    { kind: "select", field: "responsible_employee_id", label: "Ответственный", resource: "employees", optionLabel: "full_name", optionValue: "employee_id" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const WorkshopList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "workshop_id", order: "asc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Цеха">
      <ReferenceFilterBar storageKey="workshops" config={WORKSHOPS_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        rowKey="workshop_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("workshops", record.workshop_id);
          },
        })}
      >
        <Table.Column dataIndex="workshop_id" title="ID" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column
          dataIndex="workshop_name"
          title="Название цеха"
          sorter
        />
        <Table.Column dataIndex="address" title="Адрес цеха" />
        <Table.Column
          dataIndex={["employee", "full_name"]}
          title="Ответственный"
          render={(_, record: any) => record?.employee?.full_name || "-"}
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
            <Space>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.workshop_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.workshop_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};


