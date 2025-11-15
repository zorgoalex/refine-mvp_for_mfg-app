import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { useMemo } from "react";
import { useHighlightRow } from "../../hooks/useHighlightRow";

export const VendorList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "vendor_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "vendor_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  const materialTypeIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.material_type_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const { data: materialTypesData } = useMany({
    resource: "material_types",
    ids: materialTypeIds,
    queryOptions: { enabled: materialTypeIds.length > 0 },
  });

  const materialTypeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (materialTypesData?.data || []).forEach((t: any) => {
      map[t.material_type_id] = t.material_type_name;
    });
    return map;
  }, [materialTypesData]);

  return (
    <LocalizedList title="Производители">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="vendor_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("vendors", record.vendor_id);
          },
        })}
      >
        <Table.Column dataIndex="vendor_id" title="id" sorter />
        <Table.Column dataIndex="vendor_name" title="Производитель" sorter />
        <Table.Column
          dataIndex="contact_info"
          title="Контактная информация"
        />
        <Table.Column
          dataIndex="material_type_id"
          title="Тип материала"
          render={(_, record: any) =>
            materialTypeMap[record?.material_type_id] ??
            record?.material_type_id
          }
        />
        <Table.Column dataIndex="ref_key_1c" title="1C-key" />
        <Table.Column
          dataIndex="is_active"
          title="Активен"
          sorter
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
          render={(value: boolean) => (
            <Badge
              status={value ? "success" : "default"}
              text={value ? "Активен" : "Неактивен"}
            />
          )}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.vendor_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.vendor_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};


