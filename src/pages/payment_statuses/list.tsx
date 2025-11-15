import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const PaymentStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "payment_status_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "payment_status_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Статусы платежей">
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
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        <Table.Column dataIndex="color" title="Цвет статуса" />
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
