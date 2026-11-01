import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useMany, useNavigation } from "@refinedev/core";
import { ShowButton } from "@refinedev/antd";
import { ReferenceEditButton } from "../../components/referenceDrawer/ReferenceEditButton";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { useReferenceHeaderFilters } from "../../components/referenceFilters/useReferenceHeaderFilters";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Badge } from "antd";
import { useMemo } from "react";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { LocalizedList } from "../../components/LocalizedList";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";

const MATERIALS_FILTERS: ReferenceFilterConfig = {
  search: { field: "material_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "select", field: "material_type_id", label: "Тип материала", resource: "material_types", optionLabel: "material_type_name", optionValue: "material_type_id" },
    { kind: "select", field: "unit_id", label: "Единица", resource: "units", optionLabel: "unit_name", optionValue: "unit_id" },
    { kind: "select", field: "vendor_id", label: "Производитель", resource: "vendors", optionLabel: "vendor_name", optionValue: "vendor_id" },
    { kind: "select", field: "default_supplier_id", label: "Поставщик", resource: "suppliers", optionLabel: "supplier_name", optionValue: "supplier_id" },
    { kind: "text", field: "ref_key_1c", label: "Ключ 1С" },
  ],
};

const MATERIALS_HEADER_FILTERS = {
  resource: "materials",
  fields: ["material_name", "unit_id", "material_type_id", "vendor_id", "default_supplier_id", "description", "ref_key_1c"],
  lookups: {
    unit_id: { resource: "units", optionValue: "unit_id", optionLabel: "unit_name" },
    material_type_id: { resource: "material_types", optionValue: "material_type_id", optionLabel: "material_type_name" },
    vendor_id: { resource: "vendors", optionValue: "vendor_id", optionLabel: "vendor_name" },
    default_supplier_id: { resource: "suppliers", optionValue: "supplier_id", optionLabel: "supplier_name" },
  },
};

export const MaterialList: React.FC<IResourceComponentsProps> = () => {
  const table = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "material_id", order: "asc" }],
    },
  });
  const { filters, setFilters, setCurrent } = table;
  const { tableProps, columnFilter } = useReferenceHeaderFilters(table, MATERIALS_HEADER_FILTERS);

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
      <ReferenceFilterBar storageKey="materials" config={MATERIALS_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
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
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="material_name" {...columnFilter("material_name")} title="Материал" sorter />
        <Table.Column
          dataIndex="unit_id"
          sorter
          {...columnFilter("unit_id")}
          title="Единица"
          render={(_, record: any) =>
            unitMap[record?.unit_id] ?? record?.unit_id
          }
        />
        <Table.Column
          dataIndex="material_type_id"
          sorter
          {...columnFilter("material_type_id")}
          title="Тип материала"
          render={(_, record: any) =>
            typeMap[record?.material_type_id] ?? record?.material_type_id
          }
        />
        <Table.Column
          dataIndex="vendor_id"
          sorter
          {...columnFilter("vendor_id")}
          title="Производитель"
          render={(_, record: any) =>
            vendorMap[record?.vendor_id] ?? record?.vendor_id
          }
        />
        <Table.Column
          dataIndex="default_supplier_id"
          sorter
          {...columnFilter("default_supplier_id")}
          title="Поставщик"
          render={(_, record: any) =>
            supplierMap[record?.default_supplier_id] ??
            record?.default_supplier_id
          }
        />
        <Table.Column dataIndex="description" sorter {...columnFilter("description")} title="Описание" />
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
        />
        <Table.Column dataIndex="ref_key_1c" sorter {...columnFilter("ref_key_1c")} title="1C-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space size={4}>
              <ShowButton
                hideText
                size="small"
                recordItemId={record.material_id}
              />
              <ReferenceEditButton
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
