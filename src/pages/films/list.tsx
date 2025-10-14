import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable } from "@refinedev/antd";
import { Table } from "antd";

export const FilmList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="film_id">
        <Table.Column dataIndex="film_id" title="Film ID" sorter />
        <Table.Column dataIndex="film_name" title="Name" sorter />
      </Table>
    </List>
  );
};
