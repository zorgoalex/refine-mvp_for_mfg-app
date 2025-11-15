import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const MillingTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "milling_type_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "milling_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы фрезеровок">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="milling_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("milling_types", record.milling_type_id);
          },
        })}
      >
        <Table.Column dataIndex="milling_type_id" title="id" sorter />
        <Table.Column dataIndex="milling_type_name" title="Тип фрезеровки" sorter />
        <Table.Column
          dataIndex="cost_per_sqm"
          title="Стоимость за м²"
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
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.milling_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.milling_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
