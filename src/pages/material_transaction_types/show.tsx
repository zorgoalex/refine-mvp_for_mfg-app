import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography, Tag } from "antd";

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
      <Title level={5}>Active</Title>
      <Tag color={record?.is_active ? "success" : "default"}>
        {record?.is_active ? "Yes" : "No"}
      </Tag>
      <Title level={5}>Description</Title>
      <TextField value={record?.description} />
    </Show>
  );
};
