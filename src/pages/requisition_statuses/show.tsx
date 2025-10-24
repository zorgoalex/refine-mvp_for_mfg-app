import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const RequisitionStatusShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "requisition_status_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>ID</Title>
      <TextField value={record?.requisition_status_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.requisition_status_name} />
      <Title level={5}>Sort Order</Title>
      <TextField value={record?.sort_order} />
      <Title level={5}>Active</Title>
      <TextField value={record?.is_active ? "Yes" : "No"} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description} />
    </Show>
  );
};
