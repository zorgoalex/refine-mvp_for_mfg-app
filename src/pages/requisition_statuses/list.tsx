import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

const REQUISITION_STATUSES_FILTERS: ReferenceFilterConfig = {
  search: { field: "requisition_status_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "description", label: "Описание" },
  ],
};

export const RequisitionStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "requisition_status_id", order: "asc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "requisition_status_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Статусы заявок на закупку">
      <ReferenceFilterBar storageKey="requisition_statuses" config={REQUISITION_STATUSES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="requisition_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("requisition_statuses", record.requisition_status_id);
          },
        })}
      >
        <Table.Column dataIndex="requisition_status_id" title="id" sorter />
        <Table.Column
          dataIndex="requisition_status_name"
          title="Статус заявки"
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
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.requisition_status_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.requisition_status_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
