import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const UserShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow();
  const { data } = queryResult;
  const record = data?.data;

  return (
    <Show>
      <Title level={5}>ID Пользователя</Title>
      <TextField value={record?.user_id} />
      <Title level={5}>Логин</Title>
      <TextField value={record?.username} />
      <Title level={5}>Email</Title>
      <TextField value={record?.email || "-"} />
      <Title level={5}>Полное имя</Title>
      <TextField value={record?.full_name || "-"} />
      <Title level={5}>Роль</Title>
      <TextField value={record?.role?.role_name || "-"} />
      <Title level={5}>Активен</Title>
      <Badge
        status={record?.is_active ? "success" : "default"}
        text={record?.is_active ? "Активен" : "Неактивен"}
      />
      <Title level={5}>Последний вход</Title>
      {record?.last_login_at ? (
        <DateField value={record.last_login_at} format="YYYY-MM-DD HH:mm:ss" />
      ) : (
        <TextField value="-" />
      )}
      <Title level={5}>Создан</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Обновлен</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};

