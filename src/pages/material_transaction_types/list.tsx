import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Tag, Badge } from "antd";

export const MaterialTransactionTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "transaction_type_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="transaction_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("material_transaction_types", record.transaction_type_id);
          },
        })}
      >
        <Table.Column dataIndex="transaction_type_id" title="ID" sorter />
        <Table.Column dataIndex="transaction_type_name" title="Name" sorter />
        <Table.Column
          dataIndex="direction"
          title="Direction"
          render={(direction: any) => direction?.direction_name || "-"}
        />
        <Table.Column
          dataIndex="affects_stock"
          title="Affects Stock"
          render={(value) => <Tag color={value ? "green" : "default"}>{value ? "Yes" : "No"}</Tag>}
        />
        <Table.Column
          dataIndex="requires_document"
          title="Requires Document"
          render={(value) => <Tag color={value ? "blue" : "default"}>{value ? "Yes" : "No"}</Tag>}
        />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          sorter
          render={(value: boolean) => (
            <Badge status={value ? "success" : "default"} text={value ? "Активен" : "Неактивен"} />
          )}
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.transaction_type_id} />
              <EditButton hideText size="small" recordItemId={record.transaction_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
