import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";

export const PaymentStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });

  return (
    <List>
      <Table {...tableProps} rowKey="payment_status_id">
        <Table.Column dataIndex="payment_status_id" title="Payment Status ID" sorter />
        <Table.Column dataIndex="payment_status_name" title="Name" sorter />
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

