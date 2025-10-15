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
      <Title level={5}>Priority</Title>
      <TextField value={record?.priority} />
      <Title level={5}>Completion Date</Title>
      <DateField value={record?.completion_date} />
      <Title level={5}>Planned Completion Date</Title>
      <DateField value={record?.planned_completion_date} />
      <Title level={5}>Order Status</Title>
      <TextField value={record?.order_status_name} />
      <Title level={5}>Payment Status</Title>
      <TextField value={record?.payment_status_name} />
      <Title level={5}>Issue Date</Title>
      <DateField value={record?.issue_date} />
      <Title level={5}>Total Amount</Title>
      <TextField value={record?.total_amount} />
      <Title level={5}>Discounted Amount</Title>
      <TextField value={record?.discounted_amount} />
      <Title level={5}>Discount</Title>
      <TextField value={record?.discount} />
      <Title level={5}>Paid Amount</Title>
      <TextField value={record?.paid_amount} />
      <Title level={5}>Payment Date</Title>
      <DateField value={record?.payment_date} />
      <Title level={5}>Parts Count</Title>
      <TextField value={record?.parts_count} />
      <Title level={5}>Total Area</Title>
      <TextField value={record?.total_area} />
      <Title level={5}>Edge Type</Title>
      <TextField value={record?.edge_type_name} />
    </Show>
  );
};
