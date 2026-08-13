import { Tooltip } from '../ui/tooltipDelay';
import React from "react";
import { Layout, Space, Avatar, Typography, Dropdown, Button, Switch } from "antd";
import {
  UserOutlined,
  LogoutOutlined,
  DownOutlined,
  MenuOutlined,
  MoonOutlined,
  SunOutlined,
  SettingOutlined,
  QrcodeOutlined,
} from "@ant-design/icons";
import { useGetIdentity, useLogout } from "@refinedev/core";
import { useNavigate } from "react-router-dom";
import type { UserIdentity } from "../types/auth";
import { GlobalSvgCutUploadAction } from "./GlobalSvgCutUploadAction";
import { NotificationBell } from "./NotificationBell";
import { useAppTheme } from "../theme/ThemeProvider";
import { authStorage } from "../utils/auth";
import { authSession } from "../api/authSession";
import { featureFlags } from "../config/featureFlags";
import { canViewNavigationResource } from "../utils/navigationPermissions";
// import { NotificationTestButton } from "./NotificationTestButton"; // DEV ONLY - закомментирован

export interface AppHeaderProps {
  onOpenSider?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ onOpenSider }) => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mutate: logout } = useLogout();
  const navigate = useNavigate();
  const { mode, setMode } = useAppTheme();

  const username = identity?.username || "Пользователь";
  const role = identity?.role || "";

  // Маппинг ролей на русские названия
  const roleNames: Record<string, string> = {
    admin: "Администратор",
    manager: "Менеджер",
    top_manager: "Топ-менеджер",
    operator: "Оператор",
    worker: "Работник",
    packer: "Упаковщик",
    viewer: "Наблюдатель",
  };

  const roleName = roleNames[role] || role;

  // Scanner entry is part of the labels feature surface: hide the button when
  // the flag is off or the user lacks the scan permission (same visibility
  // source as CustomSider's menu gating).
  const currentUser = featureFlags.useBackendPermissions ? authSession.getUser() : authStorage.getUser();
  const canScan =
    featureFlags.labels &&
    canViewNavigationResource('scan', currentUser, featureFlags.useBackendPermissions);

  return (
    <Layout.Header
      style={{
        background: "var(--app-surface)",
        padding: "0 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid var(--app-border-soft)",
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
            <GlobalSvgCutUploadAction />
            {canScan && (
              <Button
                type="text"
                icon={<QrcodeOutlined style={{ fontSize: 18 }} />}
                onClick={() => navigate("/scan")}
                aria-label="Сканер бирок"
              />
            )}

            {/* Колокольчик уведомлений */}
            <NotificationBell />

            <span className="app-header__theme-toggle">
              <Tooltip title={mode === "dark" ? "Темная тема" : "Светлая тема"}>
                <Switch
                  checked={mode === "dark"}
                  checkedChildren={<MoonOutlined />}
                  unCheckedChildren={<SunOutlined />}
                  onChange={(checked) => setMode(checked ? "dark" : "light")}
                  aria-label="Переключить тему"
                />
              </Tooltip>
            </span>

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
                        <div style={{ fontSize: 12, color: "var(--app-text-muted)" }}>
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
                    key: "profile",
                    icon: <SettingOutlined />,
                    label: "Личный кабинет",
                    onClick: () => navigate("/profile"),
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
                  <Typography.Text strong className="app-header__username">{username}</Typography.Text>
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
