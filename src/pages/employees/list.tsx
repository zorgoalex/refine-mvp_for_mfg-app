import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const EmployeeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="employee_id">
        <Table.Column dataIndex="employee_id" title="ID" sorter />
        <Table.Column dataIndex="full_name" title="ФИО" sorter />
        <Table.Column dataIndex="position" title="Должность" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          render={(value) => (value ? "Да" : "Нет")}
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
