import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const MillingTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="milling_type_id">
        <Table.Column dataIndex="milling_type_id" title="Milling Type ID" sorter />
        <Table.Column dataIndex="milling_type_name" title="Name" sorter />
        <Table.Column dataIndex="cost_per_sqm" title="Cost per sqm" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.milling_type_id} />
              <EditButton hideText size="small" recordItemId={record.milling_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
