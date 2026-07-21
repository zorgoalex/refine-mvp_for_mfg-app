import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Table, Badge } from "antd";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

export const FilmTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "film_type_id", order: "asc" }],
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
        <ReferenceSortOrderColumn />
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
