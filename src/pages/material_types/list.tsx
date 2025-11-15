import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const MaterialTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "material_type_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "material_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы материалов">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="material_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("material_types", record.material_type_id);
          },
        })}
      >
        <Table.Column dataIndex="material_type_id" title="id" sorter />
        <Table.Column
          dataIndex="material_type_name"
          title="Тип материала"
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
        <Table.Column dataIndex="description" title="Описание" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.material_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.material_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
