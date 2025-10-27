import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const PaymentTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });
  const { highlightProps } = useHighlightRow("type_paid_id");

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="type_paid_id">
        <Table.Column dataIndex="type_paid_id" title="Payment Type ID" sorter />
        <Table.Column dataIndex="type_paid_name" title="Name" sorter />
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
              <ShowButton hideText size="small" recordItemId={record.type_paid_id} />
              <EditButton hideText size="small" recordItemId={record.type_paid_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

