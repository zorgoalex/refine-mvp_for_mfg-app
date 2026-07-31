import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Input, Segmented, Space, Table, Tag, Typography, message } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';

import { featureFlags } from '../../../config/featureFlags';
import { useAppSettings, SETTING_KEYS } from '../../../hooks/useAppSettings';
import { can } from '../../../utils/permissions';
import { getCurrentUserRoleKey, normalizeRoleKey } from '../../../utils/resourceVisibility';
import {
  canViewOrderFinancials,
  getOrderFinancialVisibilityOverride,
  normalizeOrderFinancialVisibilityMatrix,
  resolveOrderFinancialVisibility,
  roleHasBaseOrderFinancialAccess,
  setOrderFinancialVisibilityOverride,
  type OrderFinancialVisibilityMatrix,
  type OrderFinancialVisibilityOverride,
} from '../../../utils/orderFinancialVisibility';

const { Paragraph, Text, Title } = Typography;

interface FinancialRoleRow {
  role_id: number | string;
  role_name: string;
  is_active?: boolean;
}

interface FinancialUserRow {
  user_id: number;
  username: string;
  full_name?: string | null;
  role?: string;
  role_code?: string;
  role_name?: string;
  permissions?: string[];
  is_active?: boolean;
}

type MatrixScope = 'roles' | 'users';

const OVERRIDE_OPTIONS = [
  { label: 'Наследовать', value: 'inherit' },
  { label: 'Разрешить', value: 'allow' },
  { label: 'Запретить', value: 'deny' },
] as const;

export const FinancialLayerAccessMatrix: React.FC = () => {
  const canManage = !featureFlags.useBackendPermissions || can('settings.manage');
  const { getSetting, saveSetting, isLoading: isSettingsLoading } = useAppSettings();
  const rawMatrix = getSetting<OrderFinancialVisibilityMatrix>(SETTING_KEYS.ORDER_FINANCIAL_VISIBILITY);
  const savedMatrix = useMemo(
    () => normalizeOrderFinancialVisibilityMatrix(rawMatrix),
    [rawMatrix],
  );
  const [matrix, setMatrix] = useState(savedMatrix);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(20);

  useEffect(() => {
    setMatrix(savedMatrix);
  }, [savedMatrix]);

  const { data: rolesData, isLoading: isRolesLoading } = useList<FinancialRoleRow>({
    resource: 'roles',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    queryOptions: { enabled: canManage, refetchOnWindowFocus: false },
  });
  const { data: usersData, isLoading: isUsersLoading } = useList<FinancialUserRow>({
    resource: 'users',
    pagination: { current: accountPage, pageSize: accountPageSize },
    filters: [
      { field: 'is_active', operator: 'in', value: [true, false] },
      ...(accountSearch.trim()
        ? [{ field: 'username', operator: 'contains' as const, value: accountSearch.trim() }]
        : []),
    ],
    queryOptions: { enabled: canManage, refetchOnWindowFocus: false },
  });

  const roles = useMemo(
    () => [...(rolesData?.data ?? [])].sort((a, b) => a.role_name.localeCompare(b.role_name, 'ru')),
    [rolesData],
  );
  const users = useMemo(() => {
    return [...(usersData?.data ?? [])]
      .sort((a, b) => a.username.localeCompare(b.username, 'ru'));
  }, [usersData]);

  const saveOverride = async (
    scope: MatrixScope,
    key: string | number,
    override: OrderFinancialVisibilityOverride,
  ) => {
    const cellKey = `${scope}:${key}`;
    const previous = matrix;
    const next = setOrderFinancialVisibilityOverride(matrix, scope, key, override);
    setMatrix(next);
    setSavingCell(cellKey);
    try {
      await saveSetting(
        SETTING_KEYS.ORDER_FINANCIAL_VISIBILITY,
        next,
        'Видимость финансового слоя заказа по ролям и аккаунтам',
      );
      message.success('Доступ к финансовому слою обновлён');
    } catch {
      setMatrix(previous);
      message.error('Не удалось сохранить доступ к финансовому слою');
    } finally {
      setSavingCell(null);
    }
  };

  if (!canManage) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Недостаточно прав для управления финансовым слоем"
        description="Требуется разрешение settings.manage."
      />
    );
  }

  const roleColumns = [
    {
      title: 'Роль',
      key: 'role',
      width: 260,
      render: (_: unknown, role: FinancialRoleRow) => (
        <Space direction="vertical" size={0}>
          <Text strong>{role.role_name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{normalizeRoleKey(role)}</Text>
        </Space>
      ),
    },
    {
      title: 'Базовое право',
      key: 'base',
      width: 150,
      align: 'center' as const,
      render: (_: unknown, role: FinancialRoleRow) => (
        <BaseAccessTag allowed={roleHasBaseOrderFinancialAccess(normalizeRoleKey(role))} />
      ),
    },
    {
      title: 'Настройка слоя',
      key: 'override',
      width: 340,
      render: (_: unknown, role: FinancialRoleRow) => {
        const roleKey = normalizeRoleKey(role);
        const baseAllowed = roleHasBaseOrderFinancialAccess(roleKey);
        return renderOverrideControl({
          value: getOrderFinancialVisibilityOverride(matrix, 'roles', roleKey),
          baseAllowed,
          disabled: savingCell !== null,
          loading: savingCell === `roles:${roleKey}`,
          onChange: (value) => void saveOverride('roles', roleKey, value),
        });
      },
    },
    {
      title: 'Итог',
      key: 'effective',
      width: 130,
      align: 'center' as const,
      render: (_: unknown, role: FinancialRoleRow) => {
        const roleKey = normalizeRoleKey(role);
        const baseAllowed = roleHasBaseOrderFinancialAccess(roleKey);
        const allowed = baseAllowed && (matrix.roles[roleKey] ?? true);
        return <EffectiveAccessTag allowed={allowed} />;
      },
    },
  ];

  const userColumns = [
    {
      title: 'Аккаунт',
      key: 'account',
      width: 300,
      render: (_: unknown, user: FinancialUserRow) => (
        <Space direction="vertical" size={0}>
          <Space size={8} wrap>
            <Text strong>{user.username}</Text>
            <Badge status={user.is_active === false ? 'default' : 'success'} text={user.is_active === false ? 'Неактивен' : 'Активен'} />
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {user.full_name || 'Имя не указано'} · ID <span style={{ fontVariantNumeric: 'tabular-nums' }}>{user.user_id}</span>
          </Text>
        </Space>
      ),
    },
    {
      title: 'Роль',
      key: 'role',
      width: 180,
      render: (_: unknown, user: FinancialUserRow) => user.role_name || user.role || user.role_code || '—',
    },
    {
      title: 'Базовое право',
      key: 'base',
      width: 150,
      align: 'center' as const,
      render: (_: unknown, user: FinancialUserRow) => (
        <BaseAccessTag allowed={userHasBaseAccess(user)} />
      ),
    },
    {
      title: 'Персональная настройка',
      key: 'override',
      width: 340,
      render: (_: unknown, user: FinancialUserRow) => renderOverrideControl({
        value: getOrderFinancialVisibilityOverride(matrix, 'users', user.user_id),
        baseAllowed: userHasBaseAccess(user),
        disabled: savingCell !== null,
        loading: savingCell === `users:${user.user_id}`,
        onChange: (value) => void saveOverride('users', user.user_id, value),
      }),
    },
    {
      title: 'Итог',
      key: 'effective',
      width: 130,
      align: 'center' as const,
      render: (_: unknown, user: FinancialUserRow) => (
        <EffectiveAccessTag allowed={resolveOrderFinancialVisibility({
          baseAllowed: userHasBaseAccess(user),
          user: {
            id: user.user_id,
            role: user.role || user.role_code,
            permissions: user.permissions,
          },
          matrix,
        })} />
      ),
    },
  ];

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="financial-layer-access-title">
      <Title id="financial-layer-access-title" level={4} style={{ marginBottom: 4, textWrap: 'balance' }}>
        Доступ к финансовому слою заказа
      </Title>
      <Paragraph type="secondary" style={{ maxWidth: 920, textWrap: 'pretty' }}>
        Это ограничение поверх базовых прав. Персональная настройка имеет приоритет над ролью;
        отсутствие базового права <Text code>orders.view_financials</Text> нельзя обойти этой таблицей.
      </Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Порядок применения: аккаунт → роль → базовые права"
        description="«Наследовать» удаляет явное исключение. «Разрешить» может отменить запрет роли только для аккаунта с базовым финансовым правом."
      />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Title level={5} style={{ marginBottom: 8 }}>Роли</Title>
          <Table
            rowKey={(role) => String(role.role_id)}
            loading={isSettingsLoading || isRolesLoading}
            dataSource={roles}
            columns={roleColumns}
            pagination={false}
            size="middle"
            scroll={{ x: 'max-content' }}
          />
        </div>

        <div>
          <Space align="center" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
            <Title level={5} style={{ margin: 0 }}>Аккаунты</Title>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              value={accountSearch}
              onChange={(event) => {
                setAccountSearch(event.target.value);
                setAccountPage(1);
              }}
              placeholder="Поиск по логину, имени или роли"
              style={{ width: 340, minHeight: 40 }}
            />
          </Space>
          <Table
            rowKey="user_id"
            loading={isSettingsLoading || isUsersLoading}
            dataSource={users}
            columns={userColumns}
            pagination={{
              current: accountPage,
              pageSize: accountPageSize,
              total: usersData?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100],
              onChange: (page, pageSize) => {
                setAccountPage(page);
                setAccountPageSize(pageSize);
              },
            }}
            size="middle"
            scroll={{ x: 'max-content' }}
          />
        </div>
      </Space>
    </section>
  );
};

function userHasBaseAccess(user: FinancialUserRow): boolean {
  if (Array.isArray(user.permissions)) {
    return canViewOrderFinancials({ permissions: user.permissions });
  }
  return roleHasBaseOrderFinancialAccess(getCurrentUserRoleKey({
    role: user.role || user.role_code,
  }));
}

function renderOverrideControl(input: {
  value: OrderFinancialVisibilityOverride;
  baseAllowed: boolean;
  disabled: boolean;
  loading: boolean;
  onChange: (value: OrderFinancialVisibilityOverride) => void;
}) {
  return (
    <Space direction="vertical" size={2}>
      <Segmented
        size="large"
        value={input.value}
        disabled={input.disabled}
        options={OVERRIDE_OPTIONS.map((option) => ({
          ...option,
          disabled: option.value === 'allow' && !input.baseAllowed,
        }))}
        onChange={(value) => input.onChange(value as OrderFinancialVisibilityOverride)}
      />
      {input.loading ? <Text type="secondary" style={{ fontSize: 12 }}>Сохранение…</Text> : null}
    </Space>
  );
}

const BaseAccessTag: React.FC<{ allowed: boolean }> = ({ allowed }) => (
  <Tag color={allowed ? 'blue' : 'default'}>{allowed ? 'Есть' : 'Нет'}</Tag>
);

const EffectiveAccessTag: React.FC<{ allowed: boolean }> = ({ allowed }) => (
  <Tag color={allowed ? 'green' : 'red'}>{allowed ? 'Доступен' : 'Скрыт'}</Tag>
);
