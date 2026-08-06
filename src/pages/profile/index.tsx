import React from "react";
import { Button, Card, Checkbox, Descriptions, Radio, Space, Typography, notification } from "antd";
import { TabletOutlined } from "@ant-design/icons";
import { useGetIdentity } from "@refinedev/core";
import type { UserIdentity } from "../../types/auth";
import { useAppTheme } from "../../theme/ThemeProvider";
import { featureFlags } from "../../config/featureFlags";
import { WorkosLinkCard } from "./WorkosLinkCard";
import { useUiVariantPreference } from "../../ui-variant/useUiVariantPreference";
import { isModernUiVariant, type UiVariant } from "../../ui-variant/uiVariant";
import { hasAnyDirty, useTabStore } from "../../stores/tabStore";
import { TelegramNotificationsCard } from "./TelegramNotificationsCard";
import {
  OperationalPageHeader,
  useOperationalUi,
} from "../../ui-operational/OperationalPrimitives";

const roleNames: Record<string, string> = {
  admin: "Администратор",
  manager: "Менеджер",
  top_manager: "Топ-менеджер",
  operator: "Оператор",
  worker: "Работник",
  packer: "Упаковщик",
  viewer: "Наблюдатель",
};

const uiVariantOptions: Array<{ label: string; value: UiVariant }> = [
  { label: "Классический", value: "legacy" },
  { label: "Новый (Evolutionary)", value: "evolution" },
  { label: "LINE · Деловой минимализм", value: "line" },
  { label: "AIR · Светлая динамика", value: "air" },
];

export const ProfilePage: React.FC = () => {
  const isOperational = useOperationalUi();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mode, setMode, uiSize, setUiSize, tabletMode, setTabletMode } = useAppTheme();
  const [isTabletModeSaving, setIsTabletModeSaving] = React.useState(false);
  const {
    variant,
    modernUiAvailable,
    isSaving: isVariantSaving,
    setVariant,
  } = useUiVariantPreference();
  const roleName = identity?.role ? roleNames[identity.role] ?? identity.role : "—";
  const toggleTabletMode = async () => {
    if (hasAnyDirty(useTabStore.getState().tabs)) {
      notification.warning({
        message: "Есть несохранённые изменения",
        description: "Сохраните или отмените изменения во вкладках, затем переключите вид.",
      });
      return;
    }

    setIsTabletModeSaving(true);
    try {
      await setTabletMode(!tabletMode);
    } catch {
      notification.error({
        message: "Не удалось переключить планшетный вид",
        description: "Настройка не изменена. Попробуйте ещё раз.",
      });
    } finally {
      setIsTabletModeSaving(false);
    }
  };

  return (
    <Space
      className={`profile-page${isOperational ? " profile-page--operational" : ""}`}
      direction="vertical"
      size="middle"
      style={{ width: "100%", padding: isOperational ? 0 : 24 }}
    >
      {isOperational ? (
        <OperationalPageHeader
          compact
          breadcrumbs="Профиль / Личный кабинет"
          title="Личный кабинет"
          description="Учетная запись, уведомления и персональные настройки интерфейса."
        />
      ) : (
        <Typography.Title level={3} style={{ margin: 0 }}>
          Личный кабинет
        </Typography.Title>
      )}
      <Card>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Пользователь">
            {identity?.username ?? "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Роль">{roleName}</Descriptions.Item>
        </Descriptions>
      </Card>
      {featureFlags.workosAuth && <WorkosLinkCard />}
      <TelegramNotificationsCard />
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
            <Button
              aria-label={tabletMode ? "Отключить планшетный вид" : "Включить планшетный вид"}
              aria-pressed={tabletMode}
              icon={<TabletOutlined />}
              loading={isTabletModeSaving}
              onClick={() => void toggleTabletMode()}
              style={{ minHeight: 44 }}
              type={tabletMode ? "primary" : "default"}
            >
              Планшетный вид
            </Button>
            <Typography.Text type="secondary">
              {tabletMode
                ? "Принудительно включён для вашей учётной записи на любых устройствах и экранах."
                : "Автоматически определяется по устройству. Включите, чтобы всегда использовать планшетный интерфейс."}
            </Typography.Text>
          </Space>
          <Space direction="vertical" size={4}>
            <Typography.Text strong>Дизайн интерфейса</Typography.Text>
            <Radio.Group
              aria-label="Дизайн интерфейса"
              value={variant}
              disabled={isVariantSaving}
              onChange={(event) => void setVariant(event.target.value as UiVariant)}
            >
              <Space direction="vertical" size={0}>
                {uiVariantOptions.map((option) => (
                  <Radio
                    disabled={isModernUiVariant(option.value) && !modernUiAvailable}
                    key={option.value}
                    value={option.value}
                    style={{ minHeight: 40, display: "flex", alignItems: "center" }}
                  >
                    {option.label}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
            <Typography.Text type="secondary">
              {modernUiAvailable
                ? "После сохранения страница перезагрузится в выбранном дизайне."
                : "Новые варианты дизайна временно отключены администратором."}
            </Typography.Text>
          </Space>
        </Space>
      </Card>
    </Space>
  );
};

export default ProfilePage;
