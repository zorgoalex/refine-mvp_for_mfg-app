import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const PaymentStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "payment_status_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("payment_status_id", tableProps.dataSource);

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="payment_status_id">
        <Table.Column dataIndex="payment_status_id" title="Payment Status ID" sorter />
        <Table.Column dataIndex="payment_status_name" title="Name" sorter />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          render={(value) => (value ? "Yes" : "No")}
        />
        <Table.Column dataIndex="color" title="Color" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.payment_status_id} />
              <EditButton hideText size="small" recordItemId={record.payment_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

