import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const MaterialTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="material_type_id">
        <Table.Column dataIndex="material_type_id" title="Material Type ID" sorter />
        <Table.Column dataIndex="material_type_name" title="Name" sorter />
        <Table.Column dataIndex="description" title="Description" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.material_type_id} />
              <EditButton hideText size="small" recordItemId={record.material_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

