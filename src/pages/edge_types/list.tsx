import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const EdgeTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });
  const { highlightProps } = useHighlightRow("edge_type_id");

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="edge_type_id">
        <Table.Column dataIndex="edge_type_id" title="Edge Type ID" sorter />
        <Table.Column dataIndex="edge_type_name" title="Name" sorter />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => (value ? "Yes" : "No")}
        />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.edge_type_id} />
              <EditButton hideText size="small" recordItemId={record.edge_type_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

