import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";

export const EmployeeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "employee_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="employee_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("employees", record.employee_id);
          },
        })}
      >
        <Table.Column dataIndex="employee_id" title="ID" sorter />
        <Table.Column dataIndex="full_name" title="ФИО" sorter />
        <Table.Column dataIndex="position" title="Должность" sorter />
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
        <Table.Column dataIndex="note" title="Примечание" />
        <Table.Column dataIndex="ref_key_1c" title="Ключ 1C" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.employee_id} />
              <EditButton hideText size="small" recordItemId={record.employee_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
