import React from "react";
import { Layout, Space, Avatar, Typography, Dropdown, Button } from "antd";
import { UserOutlined, LogoutOutlined, DownOutlined } from "@ant-design/icons";
import { useGetIdentity, useLogout } from "@refinedev/core";
import type { UserIdentity } from "../types/auth";
import { NotificationBell } from "./NotificationBell";
// import { NotificationTestButton } from "./NotificationTestButton"; // DEV ONLY - закомментирован

export const AppHeader: React.FC = () => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mutate: logout } = useLogout();

  const username = identity?.username || "Пользователь";
  const role = identity?.role || "";

  // Маппинг ролей на русские названия
  const roleNames: Record<string, string> = {
    admin: "Администратор",
    manager: "Менеджер",
    top_manager: "Топ-менеджер",
    operator: "Оператор",
    worker: "Работник",
    viewer: "Наблюдатель",
  };

  const roleName = roleNames[role] || role;

  return (
    <Layout.Header
      style={{
        background: "#fff",
        padding: "0 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid #f0f0f0",
      }}
    >
      <Space size="middle" align="center">
        <Typography.Text strong style={{ fontSize: 16, lineHeight: 1.1 }}>
          ERP
          <br />
          <span style={{ fontSize: 12, fontWeight: 500 }}>Zhihaz</span>
        </Typography.Text>

        {/* DEV ONLY: Кнопки для тестирования уведомлений закомментированы */}
        {/* {import.meta.env.DEV && <NotificationTestButton />} */}
      </Space>

      <Space size="middle" align="center">
        {identity && (
          <>
            {/* Колокольчик уведомлений */}
            <NotificationBell />

            <Avatar
              style={{ backgroundColor: "#1677ff" }}
              icon={<UserOutlined />}
            >
              {username.substring(0, 1).toUpperCase()}
            </Avatar>
            <Dropdown
              menu={{
                items: [
                  {
                    key: "user-info",
                    label: (
                      <div>
                        <div style={{ fontWeight: 600 }}>{username}</div>
                        <div style={{ fontSize: 12, color: "#8c8c8c" }}>
                          {roleName}
                        </div>
                      </div>
                    ),
                    disabled: true,
                  },
                  {
                    type: "divider",
                  },
                  {
                    key: "logout",
                    icon: <LogoutOutlined />,
                    label: "Выйти",
                    onClick: () => logout(),
                  },
                ],
              }}
              trigger={["click"]}
            >
              <Button type="text">
                <Space>
                  <Typography.Text strong>{username}</Typography.Text>
                  <DownOutlined style={{ fontSize: 10 }} />
                </Space>
              </Button>
            </Dropdown>
          </>
        )}
      </Space>
    </Layout.Header>
  );
};

export default AppHeader;
