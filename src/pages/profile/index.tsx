import React from "react";
import { Card, Checkbox, Descriptions, Space, Typography } from "antd";
import { useGetIdentity } from "@refinedev/core";
import type { UserIdentity } from "../../types/auth";
import { useAppTheme } from "../../theme/ThemeProvider";

const roleNames: Record<string, string> = {
  admin: "Администратор",
  manager: "Менеджер",
  top_manager: "Топ-менеджер",
  operator: "Оператор",
  worker: "Работник",
  viewer: "Наблюдатель",
};

export const ProfilePage: React.FC = () => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mode, setMode } = useAppTheme();
  const roleName = identity?.role ? roleNames[identity.role] ?? identity.role : "—";

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%", padding: 24 }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Личный кабинет
      </Typography.Title>
      <Card>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Пользователь">
            {identity?.username ?? "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Роль">{roleName}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="Настройки интерфейса">
        <Checkbox
          checked={mode === "dark"}
          onChange={(event) => setMode(event.target.checked ? "dark" : "light")}
        >
          Использовать темную тему по умолчанию
        </Checkbox>
      </Card>
    </Space>
  );
};

export default ProfilePage;
