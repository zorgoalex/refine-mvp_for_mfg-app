import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table } from "antd";

export const OrderWorkshopList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_workshop_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        rowKey="order_workshop_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_workshops", record.order_workshop_id);
          },
        })}
      >
        <Table.Column dataIndex="order_workshop_id" title="ID" sorter />
        <Table.Column dataIndex="order_id" title="Order ID" sorter />
        <Table.Column dataIndex="workshop_id" title="Workshop ID" sorter />
        <Table.Column dataIndex="production_status_id" title="Production Status" sorter />
        <Table.Column dataIndex="sequence_order" title="Sequence" sorter />
        <Table.Column
          dataIndex="received_date"
          title="Received Date"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="started_date"
          title="Started Date"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="completed_date"
          title="Completed Date"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          title="Planned"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD" />}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.order_workshop_id} />
              <EditButton hideText size="small" recordItemId={record.order_workshop_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
