import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { permissionsMatrixApi } from '../../../api/permissionsMatrixApi';
import type {
  PermissionCatalogDto,
  RoleMatrixRoleDto,
  RolesMatrixDto,
  RolePolicyScopeValue,
} from '../../../api/types/permissionsMatrixApi.types';
import { can } from '../../../utils/permissions';

const { Text } = Typography;

type PermissionFilter = 'all' | 'enabled' | 'changed' | 'dangerous';

const FILTER_OPTIONS: Array<{ label: string; value: PermissionFilter }> = [
  { label: 'Все', value: 'all' },
  { label: 'Включены', value: 'enabled' },
  { label: 'Изменены', value: 'changed' },
  { label: 'Опасные', value: 'dangerous' },
];

const SCOPE_LABELS: Record<RolePolicyScopeValue, string> = {
  all: 'Все',
  own: 'Свои',
  assigned: 'Назначенные',
  none: 'Нет',
};

export function canViewRolesMatrixTab(): boolean {
  return can('permissions.manage') || can('system.superadmin');
}

export function RolesPermissionsMatrixTab() {
  const [matrix, setMatrix] = useState<RolesMatrixDto | null>(null);
  const [rolePermissions, setRolePermissions] = useState<Record<string, Record<string, boolean>>>({});
  const [roleScopes, setRoleScopes] = useState<Record<string, Record<string, RolePolicyScopeValue>>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PermissionFilter>('all');
  const [filterRoleId, setFilterRoleId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await permissionsMatrixApi.get();
      setMatrix(next);
      setRolePermissions(cloneBooleanMatrix(next.rolePermissions));
      setRoleScopes(cloneScopeMatrix(next.roleScopes));
      setFilterRoleId((current) => current ?? String(next.roles[0]?.roleId ?? ''));
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить права');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirtyChanges = useMemo(
    () => matrix ? collectDirtyChanges(matrix, rolePermissions, roleScopes) : [],
    [matrix, rolePermissions, roleScopes],
  );
  const hasDangerousChanges = dirtyChanges.some((change) => change.isDangerous);
  const roleOptions = useMemo(
    () => (matrix?.roles ?? []).map((role) => ({ value: String(role.roleId), label: role.roleName || role.roleCode })),
    [matrix],
  );
  const filteredPermissions = useMemo(() => {
    if (!matrix) return [];
    const normalizedSearch = search.trim().toLowerCase();
    return matrix.permissions.filter((permission) => {
      const roleId = filterRoleId ?? String(matrix.roles[0]?.roleId ?? '');
      const matchesSearch =
        !normalizedSearch ||
        permission.name.toLowerCase().includes(normalizedSearch) ||
        permission.label.toLowerCase().includes(normalizedSearch) ||
        permission.domain.toLowerCase().includes(normalizedSearch);
      if (!matchesSearch) return false;
      if (filter === 'dangerous') return permission.isDangerous;
      if (filter === 'enabled') return rolePermissions[roleId]?.[permission.name] === true;
      if (filter === 'changed') {
        return matrix.roles.some((role) =>
          matrix.rolePermissions[String(role.roleId)]?.[permission.name] !==
          rolePermissions[String(role.roleId)]?.[permission.name],
        );
      }
      return true;
    });
  }, [filter, filterRoleId, matrix, rolePermissions, search]);

  const permissionColumns = useMemo(() => {
    const roles = matrix?.roles ?? [];
    return [
      {
        title: 'Право',
        dataIndex: 'name',
        key: 'name',
        fixed: 'left' as const,
        width: 320,
        render: (_: unknown, permission: PermissionCatalogDto) => (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              <Text strong>{permission.label}</Text>
              {permission.isDangerous && <Tag color="red">опасное</Tag>}
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>{permission.name}</Text>
            <Tag>{permission.domain}</Tag>
          </Space>
        ),
      },
      ...roles.map((role) => ({
        title: renderRoleTitle(role, matrix),
        key: String(role.roleId),
        align: 'center' as const,
        width: 160,
        render: (_: unknown, permission: PermissionCatalogDto) => {
          const roleId = String(role.roleId);
          return (
            <Checkbox
              aria-label={`${role.roleName} ${permission.name}`}
              checked={rolePermissions[roleId]?.[permission.name] === true}
              onChange={(event) => updatePermission(roleId, permission.name, event.target.checked)}
            />
          );
        },
      })),
    ];
  }, [matrix, rolePermissions]);

  const scopeColumns = useMemo(() => {
    const roles = matrix?.roles ?? [];
    return [
      {
        title: 'Область',
        dataIndex: 'key',
        key: 'key',
        fixed: 'left' as const,
        width: 260,
        render: (key: string) => (
          <Space direction="vertical" size={2}>
            <Text strong>{key}</Text>
          </Space>
        ),
      },
      ...roles.map((role) => ({
        title: renderRoleTitle(role, matrix),
        key: String(role.roleId),
        align: 'center' as const,
        width: 180,
        render: (_: unknown, row: NonNullable<RolesMatrixDto['scopeKeys']>[number]) => {
          const roleId = String(role.roleId);
          return (
            <Select
              aria-label={`${role.roleName} ${row.key}`}
              size="small"
              style={{ width: 140 }}
              value={roleScopes[roleId]?.[row.key] ?? 'none'}
              options={row.allowedValues.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
              onChange={(value) => updateScope(roleId, row.key, value)}
            />
          );
        },
      })),
    ];
  }, [matrix, roleScopes]);

  function updatePermission(roleId: string, permissionName: string, enabled: boolean) {
    setRolePermissions((current) => ({
      ...current,
      [roleId]: {
        ...(current[roleId] ?? {}),
        [permissionName]: enabled,
      },
    }));
  }

  function updateScope(roleId: string, scopeKey: string, scopeValue: RolePolicyScopeValue) {
    setRoleScopes((current) => ({
      ...current,
      [roleId]: {
        ...(current[roleId] ?? {}),
        [scopeKey]: scopeValue,
      },
    }));
  }

  async function persist(confirmDangerous: boolean) {
    if (!matrix || dirtyChanges.length === 0) return;
    setSaving(true);
    try {
      const next = await permissionsMatrixApi.update({
        version: matrix.version,
        rolePermissions,
        roleScopes,
        confirmDangerous,
      });
      setMatrix(next);
      setRolePermissions(cloneBooleanMatrix(next.rolePermissions));
      setRoleScopes(cloneScopeMatrix(next.roleScopes));
      message.success('Права ролей сохранены');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        Modal.warning({
          title: 'Матрица устарела',
          content: 'Права уже изменены в другой сессии. Обновите данные и повторите сохранение.',
          onOk: load,
        });
      } else if (error instanceof ApiError && error.code === 'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED') {
        confirmSaveDangerous();
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить права');
      }
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    if (hasDangerousChanges) {
      confirmSaveDangerous();
      return;
    }
    void persist(false);
  }

  function confirmSaveDangerous() {
    Modal.confirm({
      title: 'Подтвердите опасные права',
      content: renderDiffPreview(dirtyChanges.filter((change) => change.isDangerous).slice(0, 8)),
      okText: 'Сохранить',
      cancelText: 'Отмена',
      onOk: () => persist(true),
    });
  }

  async function resetRole(roleId: number) {
    setSaving(true);
    try {
      const next = await permissionsMatrixApi.resetRoleToDefaults(roleId);
      setMatrix(next);
      setRolePermissions(cloneBooleanMatrix(next.rolePermissions));
      setRoleScopes(cloneScopeMatrix(next.roleScopes));
      message.success('Роль сброшена к значениям по умолчанию');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сбросить роль');
    } finally {
      setSaving(false);
    }
  }

  if (!canViewRolesMatrixTab()) {
    return <Empty description="Недостаточно прав" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="Поиск"
            style={{ width: 260 }}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            style={{ width: 160 }}
            value={filter}
            options={FILTER_OPTIONS}
            onChange={setFilter}
          />
          <Select
            style={{ width: 180 }}
            value={filterRoleId ?? undefined}
            options={roleOptions}
            onChange={setFilterRoleId}
          />
        </Space>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={load} disabled={loading || saving}>
            Обновить
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            disabled={dirtyChanges.length === 0}
            loading={saving}
          >
            Сохранить
          </Button>
        </Space>
      </Space>

      {dirtyChanges.length > 0 && (
        <Alert
          type={hasDangerousChanges ? 'warning' : 'info'}
          showIcon
          message={`Изменений: ${dirtyChanges.length}`}
          description={renderDiffPreview(dirtyChanges.slice(0, 10))}
        />
      )}

      {matrix && (
        <Space wrap>
          {matrix.roles.map((role) => (
            <Popconfirm
              key={role.roleId}
              title={`Сбросить роль «${role.roleName}»?`}
              okText="Сбросить"
              cancelText="Отмена"
              onConfirm={() => resetRole(role.roleId)}
            >
              <Button icon={<UndoOutlined />} disabled={saving}>
                {role.roleName}
              </Button>
            </Popconfirm>
          ))}
        </Space>
      )}

      <Table
        rowKey="name"
        loading={loading}
        dataSource={filteredPermissions}
        columns={permissionColumns}
        pagination={false}
        size="middle"
        scroll={{ x: 'max-content', y: 520 }}
      />

      <Table
        rowKey="key"
        loading={loading}
        dataSource={matrix?.scopeKeys ?? []}
        columns={scopeColumns}
        pagination={false}
        size="middle"
        scroll={{ x: 'max-content' }}
      />
    </Space>
  );
}

function renderRoleTitle(role: RoleMatrixRoleDto, matrix: RolesMatrixDto | null) {
  const roleKey = String(role.roleId);
  const changedCount = matrix
    ? Object.entries(matrix.rolePermissions[roleKey] ?? {}).filter(
        ([permission, enabled]) => enabled !== matrix.defaults.rolePermissions[roleKey]?.[permission],
      ).length
    : 0;
  return (
    <Space direction="vertical" size={0}>
      <Text strong>{role.roleName || role.roleCode}</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>{changedCount} от базовых</Text>
    </Space>
  );
}

function cloneBooleanMatrix(input: Record<string, Record<string, boolean>>) {
  return Object.fromEntries(Object.entries(input).map(([roleId, row]) => [roleId, { ...row }]));
}

function cloneScopeMatrix(input: Record<string, Record<string, RolePolicyScopeValue>>) {
  return Object.fromEntries(Object.entries(input).map(([roleId, row]) => [roleId, { ...row }]));
}

function collectDirtyChanges(
  matrix: RolesMatrixDto,
  rolePermissions: Record<string, Record<string, boolean>>,
  roleScopes: Record<string, Record<string, RolePolicyScopeValue>>,
) {
  const roleById = new Map(matrix.roles.map((role) => [String(role.roleId), role]));
  const permissionByName = new Map(matrix.permissions.map((permission) => [permission.name, permission]));
  const changes: Array<{
    role: string;
    key: string;
    before: string;
    after: string;
    isDangerous: boolean;
  }> = [];

  for (const role of matrix.roles) {
    const roleId = String(role.roleId);
    for (const permission of matrix.permissions) {
      const before = matrix.rolePermissions[roleId]?.[permission.name] === true;
      const after = rolePermissions[roleId]?.[permission.name] === true;
      if (before !== after) {
        changes.push({
          role: role.roleName || role.roleCode,
          key: permission.name,
          before: before ? 'включено' : 'выключено',
          after: after ? 'включено' : 'выключено',
          isDangerous: permissionByName.get(permission.name)?.isDangerous === true,
        });
      }
    }
    for (const scopeKey of matrix.scopeKeys) {
      const before = matrix.roleScopes[roleId]?.[scopeKey.key] ?? 'none';
      const after = roleScopes[roleId]?.[scopeKey.key] ?? 'none';
      if (before !== after) {
        changes.push({
          role: roleById.get(roleId)?.roleName || roleId,
          key: scopeKey.key,
          before: SCOPE_LABELS[before],
          after: SCOPE_LABELS[after],
          isDangerous: false,
        });
      }
    }
  }

  return changes;
}

function renderDiffPreview(changes: ReturnType<typeof collectDirtyChanges>) {
  return (
    <Space direction="vertical" size={4}>
      {changes.map((change, index) => (
        <Text key={`${change.role}-${change.key}-${index}`} style={{ fontSize: 12 }}>
          {change.role}: {change.key} - {change.before}
          {' -> '}
          {change.after}
        </Text>
      ))}
    </Space>
  );
}
