import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";

export const FilmTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="film_type_id">
        <Table.Column dataIndex="film_type_id" title="Film Type ID" sorter />
        <Table.Column dataIndex="film_type_name" title="Name" sorter />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          sorter
          render={(value) => (
            <Badge status={value ? "success" : "default"} text={value ? "Active" : "Inactive"} />
          )}
          filters={[
            { text: "Active", value: true },
            { text: "Inactive", value: false },
          ]}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.film_type_id} />
              <EditButton hideText size="small" recordItemId={record.film_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

