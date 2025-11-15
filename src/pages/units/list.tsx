import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

export const UnitList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({ syncWithLocation: true });
  const { show } = useNavigation();

  return (
    <LocalizedList title="Единицы измерения">
      <Table
        {...tableProps}
        rowKey="unit_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("units", record.unit_id);
          },
        })}
      >
        <Table.Column dataIndex="unit_id" title="id" sorter />
        <Table.Column dataIndex="unit_code" title="Код единицы" sorter />
        <Table.Column dataIndex="unit_name" title="Название" sorter />
        <Table.Column dataIndex="unit_symbol" title="Обозначение единицы" />
        <Table.Column dataIndex="decimals" title="Знаков после запятой" />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.unit_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.unit_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
