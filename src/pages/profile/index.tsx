import React from "react";
import { Button, Card, Checkbox, Descriptions, Radio, Space, Typography } from "antd";
import { TabletOutlined } from "@ant-design/icons";
import { useGetIdentity } from "@refinedev/core";
import type { UserIdentity } from "../../types/auth";
import { useAppTheme } from "../../theme/ThemeProvider";
import { featureFlags } from "../../config/featureFlags";
import { WorkosLinkCard } from "./WorkosLinkCard";
import { useUiVariantPreference } from "../../ui-variant/useUiVariantPreference";
import { isModernUiVariant, type UiVariant } from "../../ui-variant/uiVariant";
import { useOptionalUiVariant } from "../../ui-variant/UiVariantProvider";
import { TelegramNotificationsCard } from "./TelegramNotificationsCard";
import {
  OperationalPageHeader,
  useOperationalUi,
} from "../../ui-operational/OperationalPrimitives";
import { profileRoleName } from "./profileOptions";
import { useTabletModeToggle } from "./useTabletModeToggle";
import { ProfileWorkbench } from "./ProfileWorkbench";

const uiVariantOptions: Array<{ label: string; value: UiVariant }> = [
  { label: "Классический", value: "legacy" },
  { label: "Новый (Evolutionary)", value: "evolution" },
  { label: "LINE · Деловой минимализм", value: "line" },
  { label: "AIR · Светлая динамика", value: "air" },
  { label: "Нейтральная · светлая", value: "neutral" },
  { label: "NewLine · новый дизайн", value: "workbench" },
];

export const ProfilePage: React.FC = () => {
  const isWorkbench = useOptionalUiVariant()?.variant === "workbench";
  return isWorkbench ? <ProfileWorkbench /> : <ProfileClassic />;
};

const ProfileClassic: React.FC = () => {
  const isOperational = useOperationalUi();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mode, setMode, uiSize, setUiSize } = useAppTheme();
  const { tabletMode, isTabletModeSaving, toggleTabletMode } = useTabletModeToggle();
  const {
    variant,
    modernUiAvailable,
    isSaving: isVariantSaving,
    setVariant,
  } = useUiVariantPreference();
  const roleName = profileRoleName(identity?.role);

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
                ? "После сохранения страница перезагрузится в выбранном дизайне. На планшете всегда используется планшетный вид."
                : "Новые варианты дизайна временно отключены администратором."}
            </Typography.Text>
          </Space>
        </Space>
      </Card>
    </Space>
  );
};

export default ProfilePage;
