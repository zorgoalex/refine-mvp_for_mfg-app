import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable } from "@refinedev/antd";
import { Table } from "antd";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="client_id">
        <Table.Column dataIndex="client_id" title="Client ID" sorter />
        <Table.Column dataIndex="client_name" title="Name" sorter />
      </Table>
    </List>
  );
};
