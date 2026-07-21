import React from 'react';
import { Avatar, Button, Dropdown, Layout, Space, Switch, Tooltip, Typography } from 'antd';
import {
  DownOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  QrcodeOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useGetIdentity, useLogout } from '@refinedev/core';
import { useKBar } from '@refinedev/kbar';
import { useNavigate } from 'react-router-dom';
import { authSession } from '../../api/authSession';
import { NotificationBell } from '../../components/NotificationBell';
import { featureFlags } from '../../config/featureFlags';
import { useAppTheme } from '../../theme/ThemeProvider';
import type { UserIdentity } from '../../types/auth';
import { authStorage } from '../../utils/auth';
import { canViewNavigationResource } from '../../utils/navigationPermissions';

const ROLE_NAMES: Record<string, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  top_manager: 'Топ-менеджер',
  operator: 'Оператор',
  worker: 'Работник',
  viewer: 'Наблюдатель',
};

export interface EvolutionHeaderProps {
  onOpenSider?: () => void;
}

export const EvolutionHeader: React.FC<EvolutionHeaderProps> = ({ onOpenSider }) => {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const { mutate: logout } = useLogout();
  const { query } = useKBar();
  const navigate = useNavigate();
  const { mode, setMode } = useAppTheme();
  const username = identity?.username || 'Пользователь';
  const roleName = ROLE_NAMES[identity?.role || ''] || identity?.role || '';
  const currentUser = featureFlags.useBackendPermissions ? authSession.getUser() : authStorage.getUser();
  const canScan =
    featureFlags.labels &&
    canViewNavigationResource('scan', currentUser, featureFlags.useBackendPermissions);

  return (
    <Layout.Header className="evolution-header">
      <div className="evolution-header__leading">
        {onOpenSider ? (
          <Button
            aria-label="Открыть меню навигации"
            className="evolution-header__menu"
            icon={<MenuOutlined />}
            onClick={onOpenSider}
            type="text"
          />
        ) : null}
        <Button
          aria-label="Открыть быстрый переход"
          className="evolution-header__search"
          icon={<SearchOutlined />}
          onClick={() => query.toggle()}
          type="default"
        >
          <span>Быстрый переход</span>
          <kbd>Ctrl K</kbd>
        </Button>
      </div>

      <Space align="center" className="evolution-header__actions" size={8}>
        {identity && canScan ? (
          <Tooltip title="Сканер бирок">
            <Button
              aria-label="Сканер бирок"
              icon={<QrcodeOutlined />}
              onClick={() => navigate('/scan')}
              type="text"
            />
          </Tooltip>
        ) : null}
        {identity ? <NotificationBell /> : null}
        {identity ? (
          <Tooltip title={mode === 'dark' ? 'Темная тема' : 'Светлая тема'}>
            <Switch
              aria-label="Переключить тему"
              checked={mode === 'dark'}
              checkedChildren={<MoonOutlined />}
              onChange={(checked) => setMode(checked ? 'dark' : 'light')}
              unCheckedChildren={<SunOutlined />}
            />
          </Tooltip>
        ) : null}
        {identity ? (
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
            trigger={['click']}
          >
            <Button aria-label={`Меню пользователя ${username}`} className="evolution-header__identity" type="text">
              <Avatar icon={<UserOutlined />}>{username.slice(0, 1).toUpperCase()}</Avatar>
              <span className="evolution-header__identity-copy">
                <Typography.Text strong>{username}</Typography.Text>
                <Typography.Text type="secondary">{roleName}</Typography.Text>
              </span>
              <DownOutlined />
            </Button>
          </Dropdown>
        ) : null}
      </Space>
    </Layout.Header>
  );
};

