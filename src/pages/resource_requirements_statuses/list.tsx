import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

const RESOURCE_REQUIREMENTS_STATUSES_FILTERS: ReferenceFilterConfig = {
  search: { field: "requirement_status_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "requirement_status_code", label: "Код статуса" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const ResourceRequirementStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "requirement_status_id", order: "asc" }],
    },
  });
  const { highlightProps } = useHighlightRow("requirement_status_id", tableProps.dataSource);
  const { show } = useNavigation();

  return (
    <LocalizedList title="Статусы потребности в ресурсах">
      <ReferenceFilterBar storageKey="resource_requirements_statuses" config={RESOURCE_REQUIREMENTS_STATUSES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="requirement_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("resource_requirements_statuses", record.requirement_status_id);
          },
        })}
      >
        <Table.Column dataIndex="requirement_status_id" title="id" sorter />
        <Table.Column
          dataIndex="requirement_status_code"
          title="Статус потребности"
          sorter
        />
        <Table.Column
          dataIndex="requirement_status_name"
          title="Название потребности"
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
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.requirement_status_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.requirement_status_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
