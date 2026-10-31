import { Alert, Button, Card, Checkbox, Select, Space, Tag, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Table } from '../../ui/tooltipDelay';
import { createActionKeyStore } from '../../api/actionIdempotency';
import { accessGroupsApi, newAccessGroupsActionKey } from '../../api/accessGroupsApi';
import { permissionsMatrixApi } from '../../api/permissionsMatrixApi';
import type { AccessGroupsListDto, UserAuthorizationSourcesDto } from '../../api/types/accessGroupsApi.types';
import type { PermissionCatalogDto } from '../../api/types/permissionsMatrixApi.types';
import { can } from '../../utils/permissions';
import { hasuraReachGaps } from '../../utils/hasuraPermissionReach';
import { accessGroupsErrorText, createRequestGenerations, createSaveReloadCoordinator, isStaleConflict, sameSet, sourceLabel, userGroupsAfterReload } from '../configuration/accessGroupsModel';

const { Text } = Typography;

interface Props {
  userId: number;
  /** A confirmed change of the groups: the row version it was sent with and the one the server returned. */
  onVersionAdvanced: (sent: number, returned: number) => void;
  /** Changes when the user form saved the user (role, activity): the effective rights are read again. */
  reloadKey?: number;
}

export function canViewUserAccessGroups(): boolean {
  return can('permissions.manage') || can('system.superadmin');
}

/**
 * The user card (access groups plan v6 §6): the user's access groups and the effective permissions with the source of
 * each (role or group). Changing the groups uses users.row_version, as every command over the user.
 */
export function UserAccessGroupsCard({ userId, onVersionAdvanced, reloadKey = 0 }: Props) {
  const [authorization, setAuthorization] = useState<UserAuthorizationSourcesDto | null>(null);
  const [groups, setGroups] = useState<AccessGroupsListDto | null>(null);
  const [catalog, setCatalog] = useState<PermissionCatalogDto[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  // Permissions of groups by `groupId:version` (a changed group is read again); failed reads make the warning unknown.
  const [groupPermissions, setGroupPermissions] = useState<Map<string, string[]>>(new Map());
  const [warningsUnknown, setWarningsUnknown] = useState(false);
  const [onlyGroups, setOnlyGroups] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const keys = useRef(createActionKeyStore(newAccessGroupsActionKey)).current;
  const editable = can('permissions.manage') && can('system.superadmin');
  // The groups as last read from the server: a reload keeps an unsaved choice (userGroupsAfterReload).
  const savedGroups = useRef<number[] | null>(null);
  const selectedRef = useRef<number[]>([]);
  selectedRef.current = selected;
  // A save starts a new generation: a read sent before it must not overwrite its confirmed answer.
  const generations = useRef(createRequestGenerations()).current;
  // A reload asked for during a save (role saved in the form, conflict) runs after the save, never alongside it.
  const coordinator = useRef(createSaveReloadCoordinator()).current;
  // The card belongs to one user (mounted with key={userId}); answers arriving after it is gone change nothing.
  const alive = useRef(true);
  useEffect(() => {
    // Set on every setup: StrictMode runs setup → cleanup → setup in development.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const generation = generations.begin();
    setLoading(true);
    try {
      const [auth, list, matrix] = await Promise.all([
        accessGroupsApi.userAuthorization(userId),
        accessGroupsApi.list(),
        permissionsMatrixApi.get(),
      ]);
      if (!generations.isCurrent(generation)) return;
      setAuthorization(auth);
      setGroups(list);
      setCatalog(matrix.permissions);
      const saved = auth.groups.map((group) => group.groupId);
      // The choice and the version it is compared with change together (the selection is locked while loading, so
      // selectedRef is what the user has).
      const merged = userGroupsAfterReload(selectedRef.current, savedGroups.current, saved);
      savedGroups.current = saved;
      setSelected(merged.groups);
      if (merged.discarded) message.warning('Группы пользователя изменили в другой сессии: ваш несохранённый выбор заменён текущими группами.');
    } catch (error) {
      if (generations.isCurrent(generation)) message.error(accessGroupsErrorText(error, 'Не удалось загрузить права пользователя'));
    } finally {
      if (generations.isCurrent(generation)) setLoading(false);
    }
  }, [generations, userId]);

  useEffect(() => {
    coordinator.reload(() => void load());
  }, [coordinator, load, reloadKey]);

  // Permissions of the chosen groups — for the Hasura warning before saving; keyed by the group's current version.
  const groupKeys = useMemo(() => {
    const versions = new Map((groups?.groups ?? []).map((group) => [group.groupId, group.version]));
    return selected.map((groupId) => ({ groupId, key: `${groupId}:${versions.get(groupId) ?? '?'}` }));
  }, [groups, selected]);

  useEffect(() => {
    const missing = groupKeys.filter(({ key }) => !groupPermissions.has(key));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(({ groupId, key }) => accessGroupsApi.get(groupId).then((group) => [key, group.permissions] as const)))
      .then((loaded) => {
        if (cancelled) return;
        setWarningsUnknown(false);
        setGroupPermissions((current) => new Map([...current, ...loaded]));
      })
      .catch(() => {
        if (!cancelled) setWarningsUnknown(true);
      });
    return () => {
      cancelled = true;
    };
  }, [groupKeys, groupPermissions]);

  const labels = useMemo(() => new Map(catalog.map((permission) => [permission.name, permission.label])), [catalog]);
  const groupNames = useMemo(() => new Map((groups?.groups ?? []).map((group) => [group.code, group.name])), [groups]);
  const rows = useMemo(
    () => (authorization?.permissions ?? []).filter((row) => !onlyGroups || row.sources.some((source) => source !== 'role')),
    [authorization, onlyGroups],
  );
  const gaps = useMemo(() => {
    const permissions = [...new Set(groupKeys.flatMap(({ key }) => groupPermissions.get(key) ?? []))];
    // Permissions the user has from the role are not reported: the group adds nothing there.
    const fromRole = new Set((authorization?.permissions ?? []).filter((row) => row.sources.includes('role')).map((row) => row.permission));
    return hasuraReachGaps(permissions, authorization?.roleCode, fromRole);
  }, [authorization, groupKeys, groupPermissions]);

  if (!canViewUserAccessGroups()) return null;

  const dirty = authorization ? !sameSet(selected, authorization.groups.map((group) => group.groupId)) : false;

  async function save() {
    if (!authorization) return;
    // The version read together with the groups the choice was made from — never a newer one from the user form: a
    // newer version would let a choice based on old memberships pass the check.
    const rowVersion = authorization.rowVersion;
    const request = { rowVersion, groupIds: [...selected].sort((a, b) => a - b) };
    const key = keys.keyFor(request);
    await coordinator.save(async () => {
      generations.begin();
      setLoading(false);
      setSaving(true);
      try {
        const next = await accessGroupsApi.replaceUserGroups(userId, request, key);
        keys.succeeded(key);
        if (!alive.current || next.userId !== userId) return;
        // Any read begun before this answer must not replace it.
        generations.begin();
        setAuthorization(next);
        savedGroups.current = next.groups.map((group) => group.groupId);
        setSelected(savedGroups.current);
        onVersionAdvanced(rowVersion, next.rowVersion);
        message.success('Группы доступа пользователя сохранены');
      } catch (error) {
        if (!alive.current) return;
        message.error(accessGroupsErrorText(error));
        // Read again after this save has finished (the coordinator runs it then).
        if (isStaleConflict(error)) coordinator.reload(() => void load());
      } finally {
        if (alive.current) setSaving(false);
      }
    });
  }

  return (
    <Card
      title="Группы доступа и итоговые права"
      style={{ marginTop: 16 }}
      loading={loading && !authorization}
      extra={editable && (
        <Button type="primary" icon={<SaveOutlined />} disabled={!dirty || loading} loading={saving} onClick={() => void save()}>
          Сохранить группы
        </Button>
      )}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {groups && !groups.enabled && (
          <Alert type="info" showIcon message="Группы доступа выключены: сейчас права пользователя — только права роли." />
        )}
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          placeholder="Без групп"
          disabled={!editable || saving || loading}
          optionFilterProp="label"
          value={selected}
          onChange={(values: number[]) => setSelected(values)}
          options={(groups?.groups ?? []).map((group) => ({
            value: group.groupId,
            label: group.isActive ? group.name : `${group.name} (выключена)`,
          }))}
        />
        {warningsUnknown && selected.length > 0 && (
          <Alert type="warning" showIcon message="Не удалось проверить ограничения Hasura для выбранных групп" />
        )}
        {gaps.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="Не всё из групп сработает в разделах, которые читают базу напрямую (Hasura)"
            description={
              <Space direction="vertical" size={2}>
                {gaps.map((gap) => (
                  <Text key={gap.permission} style={{ fontSize: 12 }}>
                    {labels.get(gap.permission) ?? gap.permission}: у роли нет {gap.targets.join(', ')}
                  </Text>
                ))}
              </Space>
            }
          />
        )}
        <Space>
          <Text strong>Итоговые права</Text>
          <Checkbox checked={onlyGroups} onChange={(event) => setOnlyGroups(event.target.checked)}>Только из групп</Checkbox>
        </Space>
        <Table
          rowKey="permission"
          size="small"
          dataSource={rows}
          pagination={false}
          scroll={{ y: 360 }}
          columns={[
            {
              title: 'Право',
              key: 'permission',
              render: (_: unknown, row: UserAuthorizationSourcesDto['permissions'][number]) => (
                <Space direction="vertical" size={0}>
                  <Text>{labels.get(row.permission) ?? row.permission}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{row.permission}</Text>
                </Space>
              ),
            },
            {
              title: 'Источник',
              key: 'sources',
              width: 260,
              render: (_: unknown, row: UserAuthorizationSourcesDto['permissions'][number]) => (
                <Space size={4} wrap>
                  {row.sources.map((source) => (
                    <Tag key={source} color={source === 'role' ? undefined : 'blue'}>{sourceLabel(source, groupNames)}</Tag>
                  ))}
                </Space>
              ),
            },
          ]}
        />
        {(authorization?.scopes.length ?? 0) > 0 && (
          <Space direction="vertical" size={4}>
            <Text strong>Области</Text>
            <Space size={[4, 4]} wrap>
              {authorization!.scopes.map((scope) => (
                <Tag key={`${scope.scopeKey}=${scope.scopeValue}`} color={scope.sources.includes('role') ? undefined : 'blue'}>
                  {scope.scopeKey}: {scope.scopeValue} ({scope.sources.map((source) => sourceLabel(source, groupNames)).join(', ')})
                </Tag>
              ))}
            </Space>
          </Space>
        )}
      </Space>
    </Card>
  );
}
