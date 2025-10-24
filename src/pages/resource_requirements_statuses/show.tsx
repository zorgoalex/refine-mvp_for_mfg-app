import { IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, BooleanField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const ResourceRequirementStatusShow: React.FC<IResourceComponentsProps> = () => {
  return (
    <Show>
      <Title level={5}>Status ID</Title>
      <TextField value="requirement_status_id" />
      <Title level={5}>Code</Title>
      <TextField value="requirement_status_code" />
      <Title level={5}>Name</Title>
      <TextField value="requirement_status_name" />
      <Title level={5}>Sort Order</Title>
      <TextField value="sort_order" />
      <Title level={5}>Description</Title>
      <TextField value="description" />
      <Title level={5}>Active</Title>
      <BooleanField value="is_active" />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value="ref_key_1c" />
    </Show>
  );
};
