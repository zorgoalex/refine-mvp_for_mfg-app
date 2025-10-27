import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField, NumberField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const OrderResourceRequirementShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "requirement_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Requirement ID</Title>
      <TextField value={record?.requirement_id} />
      <Title level={5}>Order ID</Title>
      <TextField value={record?.order_id} />
      <Title level={5}>Resource Type</Title>
      <TextField value={record?.resource_type} />
      <Title level={5}>Material ID</Title>
      <TextField value={record?.material_id} />
      <Title level={5}>Film ID</Title>
      <TextField value={record?.film_id} />
      <Title level={5}>Edge Type ID</Title>
      <TextField value={record?.edge_type_id} />
      <Title level={5}>Required Quantity</Title>
      <NumberField value={record?.required_quantity} />
      <Title level={5}>Unit ID</Title>
      <TextField value={record?.unit_id} />
      <Title level={5}>Waste Percentage</Title>
      <NumberField value={record?.waste_percentage} />
      <Title level={5}>Final Quantity</Title>
      <NumberField value={record?.final_quantity} />
      <Title level={5}>Requirement Status ID</Title>
      <TextField value={record?.requirement_status_id} />
      <Title level={5}>Supplier ID</Title>
      <TextField value={record?.supplier_id} />
      <Title level={5}>Purchase Price</Title>
      <NumberField value={record?.purchase_price} />
      <Title level={5}>Requisition ID</Title>
      <TextField value={record?.requisition_id} />
      <Title level={5}>Warehouse ID</Title>
      <TextField value={record?.warehouse_id} />
      <Title level={5}>Reserved At</Title>
      <DateField value={record?.reserved_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Consumed At</Title>
      <DateField value={record?.consumed_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Notes</Title>
      <TextField value={record?.notes} />
      <Title level={5}>Calculation Details</Title>
      <TextField value={record?.calculation_details} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
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
