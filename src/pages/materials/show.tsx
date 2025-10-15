import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const MaterialShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "material_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Material ID</Title>
      <TextField value={record?.material_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.material_name} />
      <Title level={5}>Unit</Title>
      <TextField value={record?.unit} />
      <Title level={5}>Material Type ID</Title>
      <TextField value={record?.material_type_id} />
      <Title level={5}>Vendor ID</Title>
      <TextField value={record?.vendor_id} />
      <Title level={5}>Supplier ID</Title>
      <TextField value={record?.default_supplier_id} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
