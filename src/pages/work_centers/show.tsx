import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, BooleanField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const WorkCenterShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  return (
    <Show>
      <Title level={5}>ID Участка</Title>
      <TextField value={record?.workcenter_id} />
      <Title level={5}>Код</Title>
      <TextField value={record?.workcenter_code} />
      <Title level={5}>Название</Title>
      <TextField value={record?.workcenter_name} />
      <Title level={5}>Цех</Title>
      <TextField value={record?.workshop?.workshop_name || "-"} />
      <Title level={5}>Активен</Title>
      <BooleanField value={record?.is_active} />
      <Title level={5}>Ключ 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
