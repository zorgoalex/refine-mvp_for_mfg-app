import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const OrderStatusShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "order_status_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Order Status ID</Title>
      <TextField value={record?.order_status_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.order_status_name} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};

