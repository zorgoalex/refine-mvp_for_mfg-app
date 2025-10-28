import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const ProductionStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "production_status_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("production_status_id", tableProps.dataSource);
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="production_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("production_statuses", record.production_status_id);
          },
        })}
      >
        <Table.Column dataIndex="production_status_id" title="Production Status ID" sorter />
        <Table.Column dataIndex="production_status_name" title="Name" sorter />
        <Table.Column dataIndex="sort_order" title="Sort Order" sorter />
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
        <Table.Column dataIndex="color" title="Color" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.production_status_id} />
              <EditButton hideText size="small" recordItemId={record.production_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
