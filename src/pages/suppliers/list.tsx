import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const SupplierList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "supplier_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("supplier_id", tableProps.dataSource);

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="supplier_id">
        <Table.Column dataIndex="supplier_id" title="Supplier ID" sorter />
        <Table.Column dataIndex="supplier_name" title="Name" sorter />
        <Table.Column dataIndex="address" title="Address" />
        <Table.Column dataIndex="contact_person" title="Contact Person" />
        <Table.Column dataIndex="phone" title="Phone" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          render={(value) => (
            <Badge status={value ? "success" : "default"} text={value ? "Активен" : "Неактивен"} />
          )}
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
          onFilter={(value, record: any) => record.is_active === value}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.supplier_id} />
              <EditButton hideText size="small" recordItemId={record.supplier_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

