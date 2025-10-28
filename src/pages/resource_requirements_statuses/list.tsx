import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const ResourceRequirementStatusList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "requirement_status_id", order: "desc" }],
    },
  });
  const { highlightProps } = useHighlightRow("requirement_status_id", tableProps.dataSource);
  const { show } = useNavigation();

  return (
    <List>
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="requirement_status_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("resource_requirements_statuses", record.requirement_status_id);
          },
        })}
      >
        <Table.Column dataIndex="requirement_status_id" title="Status ID" sorter />
        <Table.Column dataIndex="requirement_status_code" title="Code" sorter />
        <Table.Column dataIndex="requirement_status_name" title="Name" sorter />
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
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.requirement_status_id} />
              <EditButton hideText size="small" recordItemId={record.requirement_status_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
