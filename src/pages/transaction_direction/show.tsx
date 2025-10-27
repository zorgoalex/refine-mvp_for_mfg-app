import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const TransactionDirectionShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "direction_type_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>ID</Title>
      <TextField value={record?.direction_type_id} />
      <Title level={5}>Code</Title>
      <TextField value={record?.direction_code} />
      <Title level={5}>Name</Title>
      <TextField value={record?.direction_name} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description} />
      <Title level={5}>Active</Title>
      <Badge
        status={record?.is_active ? "success" : "default"}
        text={record?.is_active ? "Active" : "Inactive"}
      />
      <Title level={5}>Created At</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Updated At</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};
