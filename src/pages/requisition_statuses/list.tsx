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

const REQUISITION_STATUSES_FILTERS: ReferenceFilterConfig = {
  search: { field: "requisition_status_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "description", label: "Описание" },
  ],
};

const REQUISITION_STATUSES_HEADER_FILTERS = {
  resource: "requisition_statuses",
  fields: ["requisition_status_name", "description"],
};

export const RequisitionStatusList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "requisition_status_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, REQUISITION_STATUSES_HEADER_FILTERS);

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
          {...columnFilter("requisition_status_name")}
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
        <Table.Column dataIndex="description" sorter {...columnFilter("description")} title="Описание" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.requisition_status_id}
              />
              <ReferenceEditButton
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
