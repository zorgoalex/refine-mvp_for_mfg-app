import { IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const OrderWorkshopShow: React.FC<IResourceComponentsProps> = () => {
  return (
    <Show>
      <Title level={5}>Order Workshop ID</Title>
      <TextField value="order_workshop_id" />
      <Title level={5}>Order ID</Title>
      <TextField value="order_id" />
      <Title level={5}>Workshop ID</Title>
      <TextField value="workshop_id" />
      <Title level={5}>Production Status ID</Title>
      <TextField value="production_status_id" />
      <Title level={5}>Sequence Order</Title>
      <TextField value="sequence_order" />
      <Title level={5}>Received Date</Title>
      <DateField value="received_date" format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Started Date</Title>
      <DateField value="started_date" format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Completed Date</Title>
      <DateField value="completed_date" format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Planned Completion Date</Title>
      <DateField value="planned_completion_date" format="YYYY-MM-DD" />
      <Title level={5}>Responsible Employee ID</Title>
      <TextField value="responsible_employee_id" />
      <Title level={5}>Notes</Title>
      <TextField value="notes" />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value="ref_key_1c" />
    </Show>
  );
};
