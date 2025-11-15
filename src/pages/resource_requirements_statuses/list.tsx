import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

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
    <LocalizedList title="Статусы потребности в ресурсах">
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
        <Table.Column dataIndex="requirement_status_id" title="id" sorter />
        <Table.Column
          dataIndex="requirement_status_code"
          title="Статус потребности"
          sorter
        />
        <Table.Column
          dataIndex="requirement_status_name"
          title="Название потребности"
          sorter
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
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.requirement_status_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.requirement_status_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
