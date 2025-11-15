import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const TransactionDirectionList: React.FC<
  IResourceComponentsProps
> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "direction_type_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Направления движения">
      <Table
        {...tableProps}
        rowKey="direction_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("transaction_direction", record.direction_type_id);
          },
        })}
      >
        <Table.Column dataIndex="direction_type_id" title="ID" sorter />
        <Table.Column dataIndex="direction_code" title="Код направления" sorter />
        <Table.Column dataIndex="direction_name" title="Название направления" sorter />
        <Table.Column dataIndex="description" title="Описание" />
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
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.direction_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.direction_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
