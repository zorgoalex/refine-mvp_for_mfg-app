import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const WORK_CENTERS_FILTERS: ReferenceFilterConfig = {
  search: { field: "workcenter_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "workcenter_code", label: "Код участка" },
    { kind: "select", field: "workshop_id", label: "Цех", resource: "workshops", optionLabel: "workshop_name", optionValue: "workshop_id" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const WorkCenterList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "workcenter_id", order: "asc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Участки цехов">
      <ReferenceFilterBar storageKey="work_centers" config={WORK_CENTERS_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        rowKey="workcenter_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("work_centers", record.workcenter_id);
          },
        })}
      >
        <Table.Column dataIndex="workcenter_id" title="ID" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="workcenter_code" title="Код участка" sorter />
        <Table.Column
          dataIndex="workcenter_name"
          title="Название участка"
          sorter
        />
        <Table.Column
          dataIndex={["workshop", "workshop_name"]}
          title="Цех"
          render={(_, record: any) => record?.workshop?.workshop_name || "-"}
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
                recordItemId={record.workcenter_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.workcenter_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
