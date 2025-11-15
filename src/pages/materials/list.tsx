import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { useTable, ShowButton, EditButton } from "@refinedev/antd";
import { Space, Table, Badge } from "antd";
import { useMemo } from "react";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";

export const MaterialList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "material_id", order: "desc" }],
    },
  });

  const { highlightProps } = useHighlightRow(
    "material_id",
    tableProps.dataSource,
  );
  const { show } = useNavigation();

  const typeIds = useMemo(
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

  const vendorIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.vendor_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const supplierIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.default_supplier_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const unitIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((tableProps?.dataSource as any[]) || [])
            .map((i) => i?.unit_id)
            .filter((v) => v !== undefined && v !== null),
        ),
      ),
    [tableProps?.dataSource],
  );

  const { data: typesData } = useMany({
    resource: "material_types",
    ids: typeIds,
    queryOptions: { enabled: typeIds.length > 0 },
  });

  const { data: vendorsData } = useMany({
    resource: "vendors",
    ids: vendorIds,
    queryOptions: { enabled: vendorIds.length > 0 },
  });

  const { data: suppliersData } = useMany({
    resource: "suppliers",
    ids: supplierIds,
    queryOptions: { enabled: supplierIds.length > 0 },
  });

  const { data: unitsData } = useMany({
    resource: "units",
    ids: unitIds,
    queryOptions: { enabled: unitIds.length > 0 },
  });

  const typeMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (typesData?.data || []).forEach((t: any) => {
      map[t.material_type_id] = t.material_type_name;
    });
    return map;
  }, [typesData]);

  const vendorMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (vendorsData?.data || []).forEach((v: any) => {
      map[v.vendor_id] = v.vendor_name;
    });
    return map;
  }, [vendorsData]);

  const supplierMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (suppliersData?.data || []).forEach((s: any) => {
      map[s.supplier_id] = s.supplier_name;
    });
    return map;
  }, [suppliersData]);

  const unitMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (unitsData?.data || []).forEach((u: any) => {
      map[u.unit_id] = u.unit_name;
    });
    return map;
  }, [unitsData]);

  return (
    <LocalizedList title="Материалы">
      <Table
        {...tableProps}
        {...highlightProps}
        rowKey="material_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("materials", record.material_id);
          },
        })}
      >
        <Table.Column dataIndex="material_id" title="id" sorter />
        <Table.Column dataIndex="material_name" title="Материал" sorter />
        <Table.Column
          dataIndex="unit_id"
          title="Единица"
          render={(_, record: any) =>
            unitMap[record?.unit_id] ?? record?.unit_id
          }
        />
        <Table.Column
          dataIndex="material_type_id"
          title="Тип материала"
          render={(_, record: any) =>
            typeMap[record?.material_type_id] ?? record?.material_type_id
          }
        />
        <Table.Column
          dataIndex="vendor_id"
          title="Производитель"
          render={(_, record: any) =>
            vendorMap[record?.vendor_id] ?? record?.vendor_id
          }
        />
        <Table.Column
          dataIndex="default_supplier_id"
          title="Поставщик"
          render={(_, record: any) =>
            supplierMap[record?.default_supplier_id] ??
            record?.default_supplier_id
          }
        />
        <Table.Column dataIndex="description" title="Описание" />
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
                recordItemId={record.material_id}
              />
              <EditButton
                hideText
                size="small"
                recordItemId={record.material_id}
              />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
