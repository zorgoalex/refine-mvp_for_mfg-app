import React from 'react';
import { Avatar, Button, Dropdown, Tooltip } from 'antd';
import {
  LogoutOutlined,
  MoonOutlined,
  QrcodeOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useGetIdentity, useLogout } from '@refinedev/core';
import { useNavigate } from 'react-router-dom';
import { GlobalSvgCutUploadAction } from '../../components/GlobalSvgCutUploadAction';
import { NotificationBell } from '../../components/NotificationBell';
import { featureFlags } from '../../config/featureFlags';
import { useAppTheme } from '../../theme/ThemeProvider';
import type { UserIdentity } from '../../types/auth';
import { canViewNavigationResource } from '../../utils/navigationPermissions';

const ROLE_NAMES: Record<string, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  top_manager: 'Топ-менеджер',
  operator: 'Оператор',
  worker: 'Работник',
  packer: 'Упаковщик',
  viewer: 'Наблюдатель',
};

export interface EvolutionTabletUtilitiesProps {
  presentation: 'rail' | 'drawer';
}

export const EvolutionTabletUtilities: React.FC<EvolutionTabletUtilitiesProps> = ({ presentation }) => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mutate: logout } = useLogout();
  const navigate = useNavigate();
  const { mode, setMode } = useAppTheme();

  if (!identity) return null;

  const username = identity.username || 'Пользователь';
  const roleName = ROLE_NAMES[identity.role || ''] || identity.role || '';
  const canScan =
    featureFlags.labels &&
    canViewNavigationResource('scan', identity, featureFlags.useBackendPermissions);
  const tooltipPlacement = presentation === 'rail' ? 'right' : 'top';
  const popupPlacement = presentation === 'rail' ? 'rightBottom' : 'topRight';
  const nextThemeLabel = mode === 'dark' ? 'Включить светлую тему' : 'Включить темную тему';

  return (
    <div
      aria-label="Персональные действия"
      className={`evolution-tablet-utilities evolution-tablet-utilities--${presentation}`}
      role="group"
    >
      <Tooltip placement={tooltipPlacement} title="Уведомления">
        <NotificationBell
          className="evolution-tablet-utility evolution-tablet-utility--notifications"
          placement={popupPlacement}
        />
      </Tooltip>
      <GlobalSvgCutUploadAction
        className="evolution-tablet-utility evolution-tablet-utility--global-actions"
        placement={popupPlacement}
        tooltipPlacement={tooltipPlacement}
      />
      {canScan ? (
        <Tooltip placement={tooltipPlacement} title="Сканер бирок">
          <Button
            aria-label="Сканер бирок"
            className="evolution-tablet-utility evolution-tablet-utility--scanner"
            icon={<QrcodeOutlined />}
            onClick={() => navigate('/scan')}
            type="text"
          />
        </Tooltip>
      ) : null}
      <Tooltip placement={tooltipPlacement} title={nextThemeLabel}>
        <Button
          aria-label={nextThemeLabel}
          className="evolution-tablet-utility evolution-tablet-utility--theme"
          icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          onClick={() => void setMode(mode === 'dark' ? 'light' : 'dark')}
          type="text"
        />
      </Tooltip>
      <Dropdown
        menu={{
          items: [
            {
              key: 'user-info',
              disabled: true,
              label: (
                <div className="evolution-header__identity-menu">
                  <strong>{username}</strong>
                  <span>{roleName}</span>
                </div>
              ),
            },
            { type: 'divider' },
            {
              key: 'profile',
              icon: <SettingOutlined />,
              label: 'Личный кабинет',
              onClick: () => navigate('/profile'),
            },
            { type: 'divider' },
            {
              key: 'logout',
              icon: <LogoutOutlined />,
              label: 'Выйти',
              onClick: () => logout(),
            },
          ],
        }}
        placement={popupPlacement}
        trigger={['click']}
      >
        <Button
          aria-label={`Меню пользователя ${username}`}
          className="evolution-tablet-utility evolution-tablet-utility--avatar"
          type="text"
        >
          <Avatar icon={<UserOutlined />} size={30}>{username.slice(0, 1).toUpperCase()}</Avatar>
        </Button>
      </Dropdown>
    </div>
  );
};
