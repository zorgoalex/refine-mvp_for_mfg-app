import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const FilmList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="film_id">
        <Table.Column dataIndex="film_id" title="Film ID" sorter />
        <Table.Column dataIndex="film_name" title="Name" sorter />
        <Table.Column dataIndex="film_type_id" title="Film Type ID" />
        <Table.Column dataIndex="film_vendor_id" title="Film Vendor ID" />
        <Table.Column dataIndex="film_texture" title="Texture" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.film_id} />
              <EditButton hideText size="small" recordItemId={record.film_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
