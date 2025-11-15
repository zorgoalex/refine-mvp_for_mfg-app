import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const OrderWorkshopList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "order_workshop_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Заказы по цехам">
      <Table
        {...tableProps}
        rowKey="order_workshop_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_workshops", record.order_workshop_id);
          },
        })}
      >
        <Table.Column dataIndex="order_workshop_id" title="id" sorter />
        <Table.Column dataIndex="order_id" title="Заказ" sorter />
        <Table.Column dataIndex="workshop_id" title="Цех" sorter />
        <Table.Column dataIndex="production_status_id" title="Статус производства" sorter />
        <Table.Column dataIndex="sequence_order" title="Последовательный номер этапа" sorter />
        <Table.Column
          dataIndex="received_date"
          title="Дата поступления в цех"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="started_date"
          title="Дата начала работ"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="completed_date"
          title="Дата завершения"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD HH:mm" />}
        />
        <Table.Column
          dataIndex="planned_completion_date"
          title="Плановая дата завершения"
          render={(value) => value && <DateField value={value} format="YYYY-MM-DD" />}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.order_workshop_id} />
              <EditButton hideText size="small" recordItemId={record.order_workshop_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
