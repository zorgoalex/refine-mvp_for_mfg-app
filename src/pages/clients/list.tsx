import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "client_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("client_id", tableProps.dataSource);
  const { show } = useNavigation();

  return (
    <LocalizedList title="Клиенты">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="client_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("clients", record.client_id);
          },
        })}
      >
        <Table.Column dataIndex="client_id" title="id" sorter />
        <Table.Column dataIndex="client_name" title="Имя клиента" sorter />
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
        <Table.Column dataIndex="ref_key_1c" title="1С-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.client_id} />
              <EditButton hideText size="small" recordItemId={record.client_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
