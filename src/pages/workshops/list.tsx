import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { LocalizedList } from "../../components/LocalizedList";
import { Space, Table, Badge } from "antd";

export const WorkshopList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "workshop_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Цеха">
      <Table
        {...tableProps}
        rowKey="workshop_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("workshops", record.workshop_id);
          },
        })}
      >
        <Table.Column dataIndex="workshop_id" title="ID" sorter />
        <Table.Column
          dataIndex="workshop_name"
          title="Название цеха"
          sorter
        />
        <Table.Column dataIndex="address" title="Адрес цеха" />
        <Table.Column
          dataIndex={["employee", "full_name"]}
          title="Ответственный"
          render={(_, record: any) => record?.employee?.full_name || "-"}
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
                recordItemId={record.workshop_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.workshop_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};




