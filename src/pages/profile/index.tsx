import React from "react";
import { Card, Checkbox, Descriptions, Radio, Space, Typography } from "antd";
import { useGetIdentity } from "@refinedev/core";
import type { UserIdentity } from "../../types/auth";
import { useAppTheme } from "../../theme/ThemeProvider";
import { featureFlags } from "../../config/featureFlags";
import { WorkosLinkCard } from "./WorkosLinkCard";
import { useUiVariantPreference } from "../../ui-variant/useUiVariantPreference";
import type { UiVariant } from "../../ui-variant/uiVariant";

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
  const { mode, setMode, uiSize, setUiSize } = useAppTheme();
  const {
    variant,
    evolutionAvailable,
    isSaving: isVariantSaving,
    setVariant,
  } = useUiVariantPreference();
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
      {featureFlags.workosAuth && <WorkosLinkCard />}
      <Card title="Настройки интерфейса">
        <Space direction="vertical" size="small">
          <Checkbox
            checked={mode === "dark"}
            onChange={(event) => setMode(event.target.checked ? "dark" : "light")}
          >
            Использовать темную тему по умолчанию
          </Checkbox>
          <Checkbox
            checked={uiSize === "small"}
            onChange={(event) => setUiSize(event.target.checked ? "small" : "default")}
          >
            Компактный интерфейс (уменьшенные элементы)
          </Checkbox>
          <Space direction="vertical" size={4}>
            <Typography.Text strong>Дизайн интерфейса</Typography.Text>
            <Radio.Group
              aria-label="Дизайн интерфейса"
              value={variant}
              disabled={isVariantSaving}
              onChange={(event) => void setVariant(event.target.value as UiVariant)}
            >
              <Space direction="vertical" size={0}>
                <Radio
                  value="legacy"
                  style={{ minHeight: 40, display: "flex", alignItems: "center" }}
                >
                  Классический
                </Radio>
                <Radio
                  value="evolution"
                  disabled={!evolutionAvailable}
                  style={{ minHeight: 40, display: "flex", alignItems: "center" }}
                >
                  Новый
                </Radio>
              </Space>
            </Radio.Group>
            <Typography.Text type="secondary">
              {evolutionAvailable
                ? "После сохранения страница перезагрузится в выбранном дизайне."
                : "Новый дизайн временно отключён администратором."}
            </Typography.Text>
          </Space>
        </Space>
      </Card>
    </Space>
  );
};

export default ProfilePage;
