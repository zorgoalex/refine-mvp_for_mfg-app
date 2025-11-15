import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const PaymentTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "type_paid_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow(
    "type_paid_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы оплаты">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="type_paid_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("payment_types", record.type_paid_id);
          },
        })}
      >
        <Table.Column dataIndex="type_paid_id" title="id" sorter />
        <Table.Column
          dataIndex="type_paid_name"
          title="Тип оплаты"
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
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.type_paid_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.type_paid_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
