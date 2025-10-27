import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const WorkshopShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  return (
    <Show>
      <Title level={5}>ID Цеха</Title>
      <TextField value={record?.workshop_id} />
      <Title level={5}>Название</Title>
      <TextField value={record?.workshop_name} />
      <Title level={5}>Адрес</Title>
      <TextField value={record?.address || "-"} />
      <Title level={5}>Ответственный сотрудник</Title>
      <TextField value={record?.employee?.full_name || "-"} />
      <Title level={5}>Ключ 1C</Title>
      <TextField value={record?.ref_key_1c || "-"} />
      <Title level={5}>Активен</Title>
      <Badge
        status={record?.is_active ? "success" : "default"}
        text={record?.is_active ? "Активен" : "Неактивен"}
      />
      <Title level={5}>Created At</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Updated At</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};

