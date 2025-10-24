import { IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, BooleanField, DateField, NumberField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const OrderResourceRequirementShow: React.FC<IResourceComponentsProps> = () => {
  return (
    <Show>
      <Title level={5}>Requirement ID</Title>
      <TextField value="requirement_id" />
      <Title level={5}>Order ID</Title>
      <TextField value="order_id" />
      <Title level={5}>Resource Type</Title>
      <TextField value="resource_type" />
      <Title level={5}>Material ID</Title>
      <TextField value="material_id" />
      <Title level={5}>Film ID</Title>
      <TextField value="film_id" />
      <Title level={5}>Edge Type ID</Title>
      <TextField value="edge_type_id" />
      <Title level={5}>Required Quantity</Title>
      <NumberField value="required_quantity" />
      <Title level={5}>Unit ID</Title>
      <TextField value="unit_id" />
      <Title level={5}>Waste Percentage</Title>
      <NumberField value="waste_percentage" />
      <Title level={5}>Final Quantity</Title>
      <NumberField value="final_quantity" />
      <Title level={5}>Requirement Status ID</Title>
      <TextField value="requirement_status_id" />
      <Title level={5}>Supplier ID</Title>
      <TextField value="supplier_id" />
      <Title level={5}>Purchase Price</Title>
      <NumberField value="purchase_price" />
      <Title level={5}>Requisition ID</Title>
      <TextField value="requisition_id" />
      <Title level={5}>Warehouse ID</Title>
      <TextField value="warehouse_id" />
      <Title level={5}>Reserved At</Title>
      <DateField value="reserved_at" format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Consumed At</Title>
      <DateField value="consumed_at" format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Notes</Title>
      <TextField value="notes" />
      <Title level={5}>Calculation Details</Title>
      <TextField value="calculation_details" />
      <Title level={5}>Active</Title>
      <BooleanField value="is_active" />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value="ref_key_1c" />
    </Show>
  );
};
