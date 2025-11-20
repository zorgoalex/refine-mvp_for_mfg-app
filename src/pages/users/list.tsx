import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const UserList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "user_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList>
      <Table
        {...tableProps}
        rowKey="user_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("users", record.user_id);
          },
        })}
      >
        <Table.Column dataIndex="user_id" title="ID" sorter />
        <Table.Column dataIndex="username" title="Логин" sorter />
        <Table.Column dataIndex="email" title="Email" sorter />
        <Table.Column dataIndex="full_name" title="Полное имя" sorter />
        <Table.Column
          dataIndex={["role", "role_name"]}
          title="Роль"
          sorter
          render={(value, record: any) => record?.role?.role_name || "-"}
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
        <Table.Column
          dataIndex="last_login_at"
          title="Последний вход"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.user_id} />
              <EditButton hideText size="small" recordItemId={record.user_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
