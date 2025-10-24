import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const UnitShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "unit_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Unit ID</Title>
      <TextField value={record?.unit_id} />
      <Title level={5}>Code</Title>
      <TextField value={record?.unit_code} />
      <Title level={5}>Name</Title>
      <TextField value={record?.unit_name} />
      <Title level={5}>Symbol</Title>
      <TextField value={record?.unit_symbol} />
      <Title level={5}>Decimals</Title>
      <TextField value={record?.decimals} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
