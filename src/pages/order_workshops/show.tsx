import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const OrderWorkshopShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "order_workshop_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Order Workshop ID</Title>
      <TextField value={record?.order_workshop_id} />
      <Title level={5}>Order ID</Title>
      <TextField value={record?.order_id} />
      <Title level={5}>Workshop ID</Title>
      <TextField value={record?.workshop_id} />
      <Title level={5}>Production Status ID</Title>
      <TextField value={record?.production_status_id} />
      <Title level={5}>Sequence Order</Title>
      <TextField value={record?.sequence_order} />
      <Title level={5}>Received Date</Title>
      <DateField value={record?.received_date} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Started Date</Title>
      <DateField value={record?.started_date} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Completed Date</Title>
      <DateField value={record?.completed_date} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Planned Completion Date</Title>
      <DateField value={record?.planned_completion_date} format="YYYY-MM-DD" />
      <Title level={5}>Responsible Employee ID</Title>
      <TextField value={record?.responsible_employee_id} />
      <Title level={5}>Notes</Title>
      <TextField value={record?.notes} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Created At</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Updated At</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};
