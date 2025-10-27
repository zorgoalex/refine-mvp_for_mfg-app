import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const RequisitionStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "requisition_status_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("requisition_status_id", tableProps.dataSource);

  return (
    <List>
      <Table {...tableProps} {...highlightProps} rowKey="requisition_status_id">
        <Table.Column dataIndex="requisition_status_id" title="ID" sorter />
        <Table.Column dataIndex="requisition_status_name" title="Name" sorter />
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
        <Table.Column dataIndex="description" title="Description" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requisition_status_id} />
              <EditButton hideText size="small" recordItemId={record.requisition_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
