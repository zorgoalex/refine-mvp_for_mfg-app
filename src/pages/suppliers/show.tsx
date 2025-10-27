import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const SupplierShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "supplier_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Supplier ID</Title>
      <TextField value={record?.supplier_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.supplier_name} />
      <Title level={5}>Address</Title>
      <TextField value={record?.address} />
      <Title level={5}>Contact Person</Title>
      <TextField value={record?.contact_person} />
      <Title level={5}>Phone</Title>
      <TextField value={record?.phone} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description || "-"} />
      <Title level={5}>Active</Title>
      <Badge status={record?.is_active ? "success" : "default"} text={record?.is_active ? "Active" : "Inactive"} />
      <Title level={5}>Created At</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Updated At</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};

