import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Tag, Badge } from "antd";

const { Title } = Typography;

export const MaterialTransactionTypeShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "transaction_type_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>ID</Title>
      <TextField value={record?.transaction_type_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.transaction_type_name} />
      <Title level={5}>Direction</Title>
      <TextField value={record?.direction?.direction_name || "-"} />
      <Title level={5}>Affects Stock</Title>
      <Tag color={record?.affects_stock ? "green" : "default"}>
        {record?.affects_stock ? "Yes" : "No"}
      </Tag>
      <Title level={5}>Requires Document</Title>
      <Tag color={record?.requires_document ? "blue" : "default"}>
        {record?.requires_document ? "Yes" : "No"}
      </Tag>
      <Title level={5}>Sort Order</Title>
      <TextField value={record?.sort_order} />
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
