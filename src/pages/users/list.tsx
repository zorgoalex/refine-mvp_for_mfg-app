import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table } from "antd";

export const UserList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="user_id">
        <Table.Column dataIndex="user_id" title="ID" sorter />
        <Table.Column dataIndex="username" title="Логин" sorter />
        <Table.Column
          dataIndex={["employee", "full_name"]}
          title="Сотрудник"
          render={(value, record: any) => record?.employee?.full_name || "-"}
        />
        <Table.Column
          dataIndex={["role", "role_name"]}
          title="Роль"
          sorter
          render={(value, record: any) => record?.role?.role_name || "-"}
        />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          render={(value) => (value ? "Да" : "Нет")}
        />
        <Table.Column
          dataIndex="last_login_at"
          title="Последний вход"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column dataIndex="ref_key_1c" title="Ключ 1C" />
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
    </List>
  );
};
