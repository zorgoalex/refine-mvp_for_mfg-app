import { Table } from '../../../ui/tooltipDelay';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { Segmented } from '../../../ui/Segmented';
import { useList } from '@refinedev/core';

import {
  canViewResourceByRoleVisibility,
  canViewResourceForUser,
  clearUserVisibilityOverrides,
  countUserVisibilityOverrides,
  getCurrentUserRoleKey,
  getUserVisibilityOverride,
  setUserVisibilityOverride,
  type RoleVisibilityMatrix,
  type UserVisibilityOverride,
  type VisibilityResource,
} from '../../../utils/resourceVisibility';

const { Paragraph, Text } = Typography;

interface VisibilityUserRow {
  user_id: number | string;
  username: string;
  full_name?: string | null;
  role?: string;
  role_code?: string;
  role_id?: number;
  role_name?: string;
  is_active?: boolean;
}

const OVERRIDE_OPTIONS = [
  { label: 'Как у роли', value: 'inherit' },
  { label: 'Показать', value: 'show' },
  { label: 'Скрыть', value: 'hide' },
];

function roleKeyOf(user: VisibilityUserRow): string | undefined {
  return getCurrentUserRoleKey({ role: user.role || user.role_code, role_id: user.role_id });
}

const USERS_PAGE_SIZE = 200;

export const UserScreenVisibility: React.FC<{
  resources: VisibilityResource[];
  /** The latest stored setting (with pending writes applied). */
  matrix: RoleVisibilityMatrix;
  loading: boolean;
  /** True while any visibility write is in flight (shared with the role mode). */
  saving: boolean;
  apply: (update: (current: RoleVisibilityMatrix) => RoleVisibilityMatrix, success: string) => Promise<void>;
}> = ({ resources, matrix, loading, saving, apply }) => {
  const [selectedUser, setSelectedUser] = useState<VisibilityUserRow | undefined>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Server-side search: every account is reachable, not only the first page.
  const { data: usersData, isLoading: isUsersLoading } = useList<VisibilityUserRow>({
    resource: 'users',
    pagination: { current: 1, pageSize: USERS_PAGE_SIZE },
    filters: [
      { field: 'is_active', operator: 'in', value: [true, false] },
      ...(debouncedSearch ? [{ field: 'username', operator: 'contains' as const, value: debouncedSearch }] : []),
    ],
    queryOptions: { refetchOnWindowFocus: false },
  });

  const users = useMemo(
    () => [...(usersData?.data ?? [])].sort((a, b) =>
      Number(a.is_active === false) - Number(b.is_active === false)
      || a.username.localeCompare(b.username, 'ru')),
    [usersData],
  );
  const moreUsers = (usersData?.total ?? 0) > users.length;
  const selectedUserId = selectedUser ? String(selectedUser.user_id) : undefined;
  const selectedRoleKey = selectedUser ? roleKeyOf(selectedUser) : undefined;
  const overrideCount = selectedUserId ? countUserVisibilityOverrides(matrix, selectedUserId) : 0;

  const changeOverride = (resourceName: string, override: UserVisibilityOverride) => {
    if (!selectedUserId) return;
    void apply(
      (current) => setUserVisibilityOverride(current, resourceName, selectedUserId, override),
      'Видимость обновлена',
    );
  };

  const resetUser = () => {
    if (!selectedUserId) return;
    void apply(
      (current) => clearUserVisibilityOverrides(current, selectedUserId),
      'Персональные настройки пользователя сброшены',
    );
  };

  const options = useMemo(() => {
    const rows = selectedUser && !users.some((user) => String(user.user_id) === selectedUserId)
      ? [selectedUser, ...users]
      : users;
    return rows.map((user) => {
      const count = countUserVisibilityOverrides(matrix, user.user_id);
      const name = user.full_name ? `${user.username} — ${user.full_name}` : user.username;
      const role = user.role_name || roleKeyOf(user) || '—';
      return {
        value: String(user.user_id),
        label: `${name} (${role})${user.is_active === false ? ' · неактивен' : ''}${count ? ` · настроек: ${count}` : ''}`,
      };
    });
  }, [matrix, selectedUser, selectedUserId, users]);

  const columns = [
    {
      title: 'Экран / пункт меню',
      key: 'label',
      width: 260,
      render: (_: unknown, record: VisibilityResource) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.label}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{record.route}</Text>
        </Space>
      ),
    },
    {
      title: 'По роли',
      key: 'role',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, record: VisibilityResource) => (
        <VisibilityTag visible={canViewResourceByRoleVisibility(record.name, selectedRoleKey, matrix)} />
      ),
    },
    {
      title: 'Для пользователя',
      key: 'override',
      width: 320,
      render: (_: unknown, record: VisibilityResource) => (
        <Segmented
          size="small"
          options={OVERRIDE_OPTIONS}
          value={selectedUserId ? getUserVisibilityOverride(matrix, record.name, selectedUserId) : 'inherit'}
          disabled={saving}
          onChange={(value) => changeOverride(record.name, value as UserVisibilityOverride)}
        />
      ),
    },
    {
      title: 'Итог',
      key: 'effective',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, record: VisibilityResource) => (
        <VisibilityTag
          visible={canViewResourceForUser(
            record.name,
            selectedUser ? { id: selectedUser.user_id, role: selectedRoleKey } : null,
            matrix,
          )}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: '16px 0' }}>
      <Paragraph type="secondary" style={{ maxWidth: 920 }}>
        Персональная настройка важнее настройки роли. «Как у роли» — пользователь видит то же, что его роль.
        Скрытие убирает пункт из меню; доступ к данным определяют права ролей.
      </Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          showSearch
          allowClear
          style={{ width: 420 }}
          placeholder="Выберите пользователя (поиск по логину, имени, почте)"
          loading={isUsersLoading}
          value={selectedUserId}
          filterOption={false}
          onSearch={setSearch}
          onChange={(value) => {
            setSelectedUser(value === undefined ? undefined : users.find((user) => String(user.user_id) === value) ?? selectedUser);
            setSearch('');
          }}
          notFoundContent={isUsersLoading ? 'Загрузка…' : 'Никого не найдено'}
          options={options}
        />
        {selectedUserId && overrideCount > 0 && (
          <Popconfirm
            title="Сбросить все персональные настройки пользователя?"
            okText="Сбросить"
            cancelText="Отмена"
            onConfirm={resetUser}
          >
            <Button disabled={saving}>Сбросить всё ({overrideCount})</Button>
          </Popconfirm>
        )}
      </Space>
      {moreUsers && !selectedUser && (
        <Paragraph type="secondary">Показаны первые {USERS_PAGE_SIZE} аккаунтов — начните вводить имя, чтобы найти остальных.</Paragraph>
      )}
      {!selectedUser ? (
        users.length === 0 && !isUsersLoading && !debouncedSearch
          ? <Alert type="info" showIcon message="Список пользователей недоступен" />
          : <Empty description="Выберите пользователя, чтобы настроить его экраны" />
      ) : (
        <Table
          rowKey="name"
          loading={loading}
          dataSource={resources}
          columns={columns}
          pagination={false}
          size="middle"
          scroll={{ x: 'max-content' }}
        />
      )}
    </div>
  );
};

const VisibilityTag: React.FC<{ visible: boolean }> = ({ visible }) => (
  visible ? <Tag color="green">Виден</Tag> : <Tag>Скрыт</Tag>
);

export default UserScreenVisibility;
