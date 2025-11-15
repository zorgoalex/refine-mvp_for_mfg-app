import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const SupplierList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "supplier_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "supplier_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Поставщики">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="supplier_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("suppliers", record.supplier_id);
          },
        })}
      >
        <Table.Column dataIndex="supplier_id" title="id" sorter />
        <Table.Column dataIndex="supplier_name" title="Поставщик" sorter />
        <Table.Column dataIndex="address" title="Адрес поставщика" />
        <Table.Column dataIndex="contact_person" title="Контактное лицо" />
        <Table.Column dataIndex="phone" title="Телефон" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
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
          onFilter={(value, record: any) => record.is_active === value}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.supplier_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.supplier_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
