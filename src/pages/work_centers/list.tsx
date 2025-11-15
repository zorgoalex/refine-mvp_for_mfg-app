import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const WorkCenterList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "workcenter_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Участки цехов">
      <Table
        {...tableProps}
        rowKey="workcenter_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("work_centers", record.workcenter_id);
          },
        })}
      >
        <Table.Column dataIndex="workcenter_id" title="ID" sorter />
        <Table.Column dataIndex="workcenter_code" title="Код участка" sorter />
        <Table.Column
          dataIndex="workcenter_name"
          title="Название участка"
          sorter
        />
        <Table.Column
          dataIndex={["workshop", "workshop_name"]}
          title="Цех"
          render={(_, record: any) => record?.workshop?.workshop_name || "-"}
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
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.workcenter_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.workcenter_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
