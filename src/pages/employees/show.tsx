import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, BooleanField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const EmployeeShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  return (
    <Show>
      <Title level={5}>ID Сотрудника</Title>
      <TextField value={record?.employee_id} />
      <Title level={5}>ФИО</Title>
      <TextField value={record?.full_name} />
      <Title level={5}>Должность</Title>
      <TextField value={record?.position} />
      <Title level={5}>Примечание</Title>
      <TextField value={record?.note} />
      <Title level={5}>Активен</Title>
      <BooleanField value={record?.is_active} />
      <Title level={5}>Ключ 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
