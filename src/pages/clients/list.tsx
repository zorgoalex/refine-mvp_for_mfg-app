import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "client_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("client_id", tableProps.dataSource);

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="client_id">
        <Table.Column dataIndex="client_id" title="Client ID" sorter />
        <Table.Column dataIndex="client_name" title="Name" sorter />
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
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.client_id} />
              <EditButton hideText size="small" recordItemId={record.client_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};

