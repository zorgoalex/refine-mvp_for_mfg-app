import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Tag, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const MaterialTransactionTypeList: React.FC<IResourceComponentsProps> =
  () => {
    const { tableProps } = useTable({
      syncWithLocation: true,
      sorters: {
        initial: [{ field: "transaction_type_id", order: "desc" }],
      },
    });
    const { show } = useNavigation();

    return (
      <LocalizedList title="Типы операций с материалами">
        <Table
          {...tableProps}
          rowKey="transaction_type_id"
          onRow={(record) => ({
            onDoubleClick: () => {
              show("material_transaction_types", record.transaction_type_id);
            },
          })}
        >
          <Table.Column dataIndex="transaction_type_id" title="ID" sorter />
          <Table.Column
            dataIndex="transaction_type_name"
            title="Тип операции"
            sorter
          />
          <Table.Column
            dataIndex="direction"
            title="Направление движения"
            render={(direction: any) => direction?.direction_name || "-"}
          />
          <Table.Column
            dataIndex="affects_stock"
            title="Влияет на склад"
            render={(value: boolean) => (
              <Tag color={value ? "green" : "default"}>
                {value ? "Да" : "Нет"}
              </Tag>
            )}
          />
          <Table.Column
            dataIndex="requires_document"
            title="Требует документа"
            render={(value: boolean) => (
              <Tag color={value ? "blue" : "default"}>
                {value ? "Да" : "Нет"}
              </Tag>
            )}
          />
          <Table.Column
            dataIndex="sort_order"
            title="Сортировка по умолчанию"
            sorter
          />
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
              <Space size={4}>
                <ShowButton
                  hideText
                  size="small"
                  recordItemId={record.transaction_type_id}
                />
                <EditButton
                  hideText
                  size="small"
                  recordItemId={record.transaction_type_id}
                />
              </Space>
            )}
          />
        </Table>
      </LocalizedList>
    );
  };
