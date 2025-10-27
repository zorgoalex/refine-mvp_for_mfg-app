import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const VendorList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "vendor_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("vendor_id", tableProps.dataSource);

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="vendor_id">
        <Table.Column dataIndex="vendor_id" title="Vendor ID" sorter />
        <Table.Column dataIndex="vendor_name" title="Name" sorter />
        <Table.Column dataIndex="contact_info" title="Contact Info" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          dataIndex="is_active"
          title="Active"
          sorter
          filters={[
            { text: "Active", value: true },
            { text: "Inactive", value: false },
          ]}
          render={(value) => (
            <Badge status={value ? "success" : "default"} text={value ? "Active" : "Inactive"} />
          )}
        />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.vendor_id} />
              <EditButton hideText size="small" recordItemId={record.vendor_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

