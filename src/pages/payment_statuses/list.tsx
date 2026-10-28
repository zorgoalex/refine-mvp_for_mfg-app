import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { StatusColorSwatch } from "../../components/StatusColor";

const PAYMENT_STATUSES_FILTERS: ReferenceFilterConfig = {
  search: { field: "payment_status_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "text", field: "color", label: "Цвет" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

export const PaymentStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps, filters, setFilters, setCurrent } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "payment_status_id", order: "asc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "payment_status_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Статусы платежей">
      <ReferenceFilterBar storageKey="payment_statuses" config={PAYMENT_STATUSES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="payment_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("payment_statuses", record.payment_status_id);
          },
        })}
      >
        <Table.Column dataIndex="payment_status_id" title="id" sorter />
        <Table.Column
          dataIndex="payment_status_name"
          title="Статус платежа"
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
        <Table.Column
          dataIndex="color"
          title="Цвет статуса"
          align="center"
          render={(value: string | null) => <StatusColorSwatch value={value} />}
        />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.payment_status_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.payment_status_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
