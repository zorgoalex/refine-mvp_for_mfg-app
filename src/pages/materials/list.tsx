import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable } from "@refinedev/antd";
import { Table } from "antd";

export const MaterialList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="material_id">
        <Table.Column dataIndex="material_id" title="Material ID" sorter />
        <Table.Column dataIndex="material_name" title="Name" sorter />
      </Table>
    </List>
  );
};
