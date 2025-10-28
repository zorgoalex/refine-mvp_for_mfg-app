import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const UnitList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="unit_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("units", record.unit_id);
          },
        })}
      >
        <Table.Column dataIndex="unit_id" title="Unit ID" sorter />
        <Table.Column dataIndex="unit_code" title="Code" sorter />
        <Table.Column dataIndex="unit_name" title="Name" sorter />
        <Table.Column dataIndex="unit_symbol" title="Symbol" />
        <Table.Column dataIndex="decimals" title="Decimals" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.unit_id} />
              <EditButton hideText size="small" recordItemId={record.unit_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
