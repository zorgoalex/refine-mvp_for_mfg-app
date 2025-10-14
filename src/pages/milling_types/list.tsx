import { IResourceComponentsProps } from "@refinedev/core";
import { List, useTable } from "@refinedev/antd";
import { Table } from "antd";

export const MillingTypeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  return (
    <List>
      <Table {...tableProps} rowKey="milling_type_id">
        <Table.Column dataIndex="milling_type_id" title="Milling Type ID" sorter />
        <Table.Column dataIndex="milling_type_name" title="Name" sorter />
      </Table>
    </List>
  );
};
