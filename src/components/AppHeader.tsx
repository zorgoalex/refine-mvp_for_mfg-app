import React from "react";
import { Layout, Space, Avatar, Typography, Dropdown, Button } from "antd";
import { UserOutlined, LogoutOutlined, DownOutlined, MenuOutlined } from "@ant-design/icons";
import { useGetIdentity, useLogout } from "@refinedev/core";
import type { UserIdentity } from "../types/auth";
import { NotificationBell } from "./NotificationBell";
// import { NotificationTestButton } from "./NotificationTestButton"; // DEV ONLY - закомментирован

export interface AppHeaderProps {
  onOpenSider?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ onOpenSider }) => {
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
        gap: 8,
      }}
    >
      <Space size="middle" align="center" style={{ minWidth: 0, flexShrink: 1 }}>
        {onOpenSider && (
          <Button
            type="text"
            icon={<MenuOutlined style={{ fontSize: 18 }} />}
            onClick={onOpenSider}
            aria-label="Открыть меню навигации"
          />
        )}
        <Typography.Text
          strong
          style={{
            fontSize: 16,
            lineHeight: 1.1,
            whiteSpace: "nowrap",
            // On mobile, hide the "Zhihaz" subline entirely — header is
            // too narrow to fit burger + 2-line ERP title + bell + avatar.
            // The brand is still visible via the "ERP" line.
          }}
          className="app-header__brand"
        >
          <span className="app-header__brand-title">ERP</span>
          <br className="app-header__brand-break" />
          <span style={{ fontSize: 12, fontWeight: 500 }} className="app-header__brand-sub">
            Zhihaz
          </span>
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
