import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const FilmTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "film_type_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "film_type_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  return (
    <LocalizedList title="Типы плёнки">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="film_type_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("film_types", record.film_type_id);
          },
        })}
      >
        <Table.Column dataIndex="film_type_id" title="id" sorter />
        <Table.Column dataIndex="film_type_name" title="Тип плёнки" sorter />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
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
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.film_type_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.film_type_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
