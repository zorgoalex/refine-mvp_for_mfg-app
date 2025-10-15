import { IResourceComponentsProps, useMany } from "@refinedev/core";
import { List, useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table } from "antd";
import { useMemo } from "react";

export const FilmList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  const typeIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.film_type_id)
            .filter((v) => v !== undefined && v !== null)
        )
      ),
    [tableProps?.dataSource]
  );
  const vendorIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.film_vendor_id)
            .filter((v) => v !== undefined && v !== null)
        )
      ),
    [tableProps?.dataSource]
  );

  const { data: typesData } = useMany({ resource: "film_types", ids: typeIds, queryOptions: { enabled: typeIds.length > 0 } });
  const { data: vendorsData } = useMany({ resource: "film_vendors", ids: vendorIds, queryOptions: { enabled: vendorIds.length > 0 } });

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => (map[t.film_type_id] = t.film_type_name));
    return map;
  }, [typesData]);
  const vendorMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (vendorsData?.data || []).forEach((v: any) => (map[v.film_vendor_id] = v.film_vendor_name));
    return map;
  }, [vendorsData]);

  return (
    <List>
      <Table {...tableProps} rowKey="film_id">
        <Table.Column dataIndex="film_id" title="Film ID" sorter />
        <Table.Column dataIndex="film_name" title="Name" sorter />
        <Table.Column
          dataIndex="film_type_id"
          title="Film Type"
          render={(_, record: any) => typeMap[record?.film_type_id] ?? record?.film_type_id}
        />
        <Table.Column
          dataIndex="film_vendor_id"
          title="Film Vendor"
          render={(_, record: any) => vendorMap[record?.film_vendor_id] ?? record?.film_vendor_id}
        />
        <Table.Column dataIndex="film_texture" title="Texture" />
        <Table.Column dataIndex="ref_key_1c" title="Ref Key 1C" />
        <Table.Column
          title="Actions"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.film_id} />
              <EditButton hideText size="small" recordItemId={record.film_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
