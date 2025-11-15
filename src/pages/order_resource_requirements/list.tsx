import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton, DateField } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const OrderResourceRequirementList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "requirement_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("requirement_id", tableProps.dataSource);
  const { show } = useNavigation();

  return (
    <LocalizedList title="Потребности заказов в ресурсах">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="requirement_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("order_resource_requirements", record.requirement_id);
          },
        })}
      >
        <Table.Column dataIndex="requirement_id" title="id" sorter />
        <Table.Column dataIndex="order_id" title="Заказ" sorter />
        <Table.Column dataIndex="resource_type" title="Тип ресурса" sorter />
        <Table.Column dataIndex="material_id" title="Материал" />
        <Table.Column dataIndex="film_id" title="Пленка" />
        <Table.Column dataIndex="edge_type_id" title="Обкат" />
        <Table.Column dataIndex="required_quantity" title="Количество" sorter />
        <Table.Column dataIndex="final_quantity" title="Итоговое количество" sorter />
        <Table.Column dataIndex="unit_id" title="Единица" />
        <Table.Column dataIndex="requirement_status_id" title="Статус потребности" sorter />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          sorter
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Активен" : "Неактивен"}
            />
          )}
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requirement_id} />
              <EditButton hideText size="small" recordItemId={record.requirement_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
