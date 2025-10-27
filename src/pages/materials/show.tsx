import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const MaterialShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "material_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: typeOne } = useOne({ resource: "material_types", id: record?.material_type_id, queryOptions: { enabled: !!record?.material_type_id } });
  const { data: vendorOne } = useOne({ resource: "vendors", id: record?.vendor_id, queryOptions: { enabled: !!record?.vendor_id } });
  const { data: supplierOne } = useOne({ resource: "suppliers", id: record?.default_supplier_id, queryOptions: { enabled: !!record?.default_supplier_id } });
  const { data: unitOne } = useOne({ resource: "units", id: record?.unit_id, queryOptions: { enabled: !!record?.unit_id } });

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Material ID</Title>
      <TextField value={record?.material_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.material_name} />
      <Title level={5}>Unit</Title>
      <TextField value={unitOne?.data?.unit_name} />
      <Title level={5}>Material Type</Title>
      <TextField value={typeOne?.data?.material_type_name} />
      <Title level={5}>Vendor</Title>
      <TextField value={vendorOne?.data?.vendor_name} />
      <Title level={5}>Supplier</Title>
      <TextField value={supplierOne?.data?.supplier_name} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description || "-"} />
      <Title level={5}>Активен</Title>
      <Badge
        status={record?.is_active ? "success" : "default"}
        text={record?.is_active ? "Активен" : "Неактивен"}
      />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Создан</Title>
      <TextField value={record?.created_by || "-"} />
      <Title level={5}>Изменён</Title>
      <TextField value={record?.edited_by || "-"} />
      <Title level={5}>Создано</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Обновлено</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};
