import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "order_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Order ID</Title>
      <TextField value={record?.order_id} />
      <Title level={5}>Order Name</Title>
      <TextField value={record?.order_name} />
      <Title level={5}>Order Date</Title>
      <DateField value={record?.order_date} />
      <Title level={5}>Client</Title>
      <TextField value={record?.client_name} />
      <Title level={5}>Milling Type</Title>
      <TextField value={record?.milling_type_name} />
      <Title level={5}>Material</Title>
      <TextField value={record?.material_name} />
      <Title level={5}>Film</Title>
      <TextField value={record?.film_name} />
      <Title level={5}>Total Amount</Title>
      <TextField value={record?.total_amount} />
    </Show>
  );
};
