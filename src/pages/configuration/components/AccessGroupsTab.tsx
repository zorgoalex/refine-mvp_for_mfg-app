import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Table } from '../../../ui/tooltipDelay';
import { createActionKeyStore } from '../../../api/actionIdempotency';
import { ApiError } from '../../../api/apiError';
import { accessGroupsApi, newAccessGroupsActionKey } from '../../../api/accessGroupsApi';
import { permissionsMatrixApi } from '../../../api/permissionsMatrixApi';
import { usersApi } from '../../../api/usersApi';
import type { AccessGroupDto, AccessGroupsListDto, AccessGroupSummaryDto } from '../../../api/types/accessGroupsApi.types';
import type { RolesMatrixDto } from '../../../api/types/permissionsMatrixApi.types';
import type { UserDto } from '../../../api/types/userApi.types';
import { can } from '../../../utils/permissions';
import {
  ACCESS_GROUP_CODE_PATTERN,
  accessGroupsErrorText,
  addedDangerous,
  createCommandLock,
  createRequestGenerations,
  readLatest,
  draftsAfterConflict,
  draftsAfterSave,
  type DraftSection,
  type GroupDrafts,
  type GroupSection,
  groupScopeValues,
  isStaleConflict,
  memberHasuraWarnings,
  normalizeGroupScopes,
  permissionsByDomain,
  sameScopes,
  sameSet,
} from '../accessGroupsModel';

const { Text, Paragraph } = Typography;

const SCOPE_VALUE_LABELS: Record<string, string> = { all: 'Все', own: 'Свои', assigned: 'Назначенные' };

/** Changing groups needs both rights (as the roles matrix); reading — either. */
function canChangeAccessGroups(): boolean {
  return can('permissions.manage') && can('system.superadmin');
}

/**
 * «Конфигурация → Права ролей → Группы доступа» (access groups plan v6 §6): the switch, the list of groups and the card
 * of one group — its permissions and scope sets, members, activity. A group adds rights only while the switch is on.
 */
export function AccessGroupsTab() {
  const [list, setList] = useState<AccessGroupsListDto | null>(null);
  const [catalog, setCatalog] = useState<RolesMatrixDto | null>(null);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const editable = canChangeAccessGroups();
  const settingsKeys = useRef(createActionKeyStore(newAccessGroupsActionKey)).current;
  const createKeys = useRef(createActionKeyStore(newAccessGroupsActionKey)).current;
  const [createForm] = Form.useForm<{ code: string; name: string; description?: string }>();
  const [busy, setBusy] = useState(false);
  // Reads of the list (and the switch) apply only if no newer read or switch command started meanwhile.
  const listReads = useRef(createRequestGenerations()).current;
  const switchLock = useRef(createCommandLock()).current;
  const [switching, setSwitching] = useState(false);
  // «Обновить» re-reads the open group too (merged with its unsaved edits like after a conflict).
  const [refreshSignal, setRefreshSignal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    await readLatest(
      listReads,
      () => Promise.all([accessGroupsApi.list(), permissionsMatrixApi.get()]),
      ([groups, matrix]) => {
        setList(groups);
        setCatalog(matrix);
      },
      (error) => message.error(accessGroupsErrorText(error, 'Не удалось загрузить группы доступа')),
    );
    setLoading(false);
    // The user lookup is a separate right (users.view): without it the groups still load, members show by name only.
    if (can('users.view')) {
      try {
        setUsers((await usersApi.list({ pageSize: 200 })).data);
      } catch (error) {
        message.warning(accessGroupsErrorText(error, 'Не удалось загрузить список пользователей'));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshList = useCallback(async () => {
    await readLatest(listReads, () => accessGroupsApi.list(), setList,
      (error) => message.error(accessGroupsErrorText(error, 'Не удалось обновить список групп')));
  }, [listReads]);

  function toggleSwitch(enabled: boolean) {
    if (!list) return;
    Modal.confirm({
      title: enabled ? 'Включить группы доступа?' : 'Выключить группы доступа?',
      content: enabled ? (
        <Space direction="vertical" size={4}>
          <Text>Участники активных групп сразу получат права своих групп (вдобавок к правам роли).</Text>
          <Text>Все пользователи перезайдут незаметно: их токены обновятся при следующем запросе.</Text>
          <Text type="secondary">Включить можно только когда Hasura проверяет права пользователя и суммы закрыты.</Text>
        </Space>
      ) : (
        <Space direction="vertical" size={4}>
          <Text>Права снова будут только от ролей: всё, что давали группы, сразу пропадёт.</Text>
          <Text type="secondary">Сами группы, их права и участники сохранятся.</Text>
        </Space>
      ),
      okText: enabled ? 'Включить' : 'Выключить',
      cancelText: 'Отмена',
      onOk: () => switchLock.run(async () => {
        const request = { enabled, version: list.permissionsVersion };
        const key = settingsKeys.keyFor(request);
        setSwitching(true);
        // A list read sent before the command must not show the old state after it.
        listReads.begin();
        try {
          const next = await accessGroupsApi.updateSettings(request, key);
          settingsKeys.succeeded(key);
          listReads.begin();
          setList(next);
          message.success(enabled ? 'Группы доступа включены' : 'Группы доступа выключены');
        } catch (error) {
          message.error(accessGroupsErrorText(error));
          if (isStaleConflict(error)) await refreshList();
        } finally {
          setSwitching(false);
        }
      }),
    });
  }

  async function createGroup() {
    const values = await createForm.validateFields();
    const request = { code: values.code.trim(), name: values.name.trim(), description: values.description?.trim() || null };
    const key = createKeys.keyFor(request);
    setBusy(true);
    try {
      const created = await accessGroupsApi.create(request, key);
      createKeys.succeeded(key);
      setCreateOpen(false);
      createForm.resetFields();
      await refreshList();
      setSelectedId(created.groupId);
      message.success('Группа создана');
    } catch (error) {
      message.error(accessGroupsErrorText(error));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo(() => [
    {
      title: 'Группа',
      key: 'name',
      render: (_: unknown, group: AccessGroupSummaryDto) => (
        <Space direction="vertical" size={0}>
          <Text strong>{group.name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{group.code}</Text>
        </Space>
      ),
    },
    { title: 'Прав', dataIndex: 'permissionCount', key: 'permissionCount', width: 80, align: 'center' as const },
    { title: 'Участников', dataIndex: 'memberCount', key: 'memberCount', width: 110, align: 'center' as const },
    {
      title: 'Состояние',
      key: 'isActive',
      width: 120,
      render: (_: unknown, group: AccessGroupSummaryDto) => group.isActive ? <Tag color="green">активна</Tag> : <Tag>выключена</Tag>,
    },
  ], []);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {list && (
        <Alert
          type={list.enabled ? 'success' : 'info'}
          showIcon
          message={list.enabled ? 'Группы доступа включены' : 'Группы доступа выключены'}
          description={
            <Space direction="vertical" size={4}>
              <Text>
                {list.enabled
                  ? 'Итоговые права пользователя — права роли и всех его активных групп.'
                  : 'Группы можно создавать и наполнять, но права никому не добавляются, пока группы не включены.'}
              </Text>
              <Text type="secondary">
                Группа не меняет роль: таблицы, которые читает интерфейс напрямую (Hasura), открываются только в пределах роли.
                Любое изменение групп обновляет права всех пользователей при их следующем запросе.
              </Text>
            </Space>
          }
          action={editable && (
            <Space>
              <Text>Включены</Text>
              <Switch checked={list.enabled} onChange={toggleSwitch} loading={switching} disabled={loading || switching} />
            </Space>
          )}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={9}>
          <Card
            size="small"
            title="Группы доступа"
            extra={
              <Space>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => { setRefreshSignal((value) => value + 1); void load(); }} disabled={loading}>Обновить</Button>
                {editable && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>Создать</Button>}
              </Space>
            }
          >
            <Table
              rowKey="groupId"
              size="small"
              loading={loading}
              dataSource={list?.groups ?? []}
              columns={columns}
              pagination={false}
              locale={{ emptyText: <Empty description="Групп пока нет" /> }}
              onRow={(group: AccessGroupSummaryDto) => ({ onClick: () => setSelectedId(group.groupId), style: { cursor: 'pointer' } })}
              rowClassName={(group: AccessGroupSummaryDto) => (group.groupId === selectedId ? 'ant-table-row-selected' : '')}
            />
          </Card>
        </Col>
        <Col xs={24} xxl={15}>
          {selectedId != null && catalog ? (
            <AccessGroupEditor
              key={selectedId}
              groupId={selectedId}
              refreshSignal={refreshSignal}
              catalog={catalog}
              users={users}
              editable={editable}
              onChanged={refreshList}
              onDeleted={() => {
                setSelectedId(null);
                void refreshList();
              }}
            />
          ) : (
            <Card size="small"><Empty description="Выберите группу слева" /></Card>
          )}
        </Col>
      </Row>

      <Modal
        open={createOpen}
        title="Новая группа доступа"
        okText="Создать"
        cancelText="Отмена"
        confirmLoading={busy}
        onOk={() => void createGroup()}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            label="Название"
            name="name"
            rules={[{ required: true, whitespace: true, message: 'Введите название' }, { max: 120, message: 'Не длиннее 120 символов' }]}
          >
            <Input placeholder="Смена менеджера" />
          </Form.Item>
          <Form.Item
            label="Код"
            name="code"
            extra="Латиница в нижнем регистре, цифры и «_»; потом не меняется"
            rules={[{ required: true, message: 'Введите код' }, { pattern: ACCESS_GROUP_CODE_PATTERN, message: 'Например: manager_change' }]}
          >
            <Input placeholder="manager_change" />
          </Form.Item>
          <Form.Item label="Описание" name="description" rules={[{ max: 1000, message: 'Не длиннее 1000 символов' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

interface EditorProps {
  groupId: number;
  /** Grows on «Обновить»: the group is read again and merged with the unsaved edits. */
  refreshSignal: number;
  catalog: RolesMatrixDto;
  users: UserDto[];
  editable: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}

function AccessGroupEditor({ groupId, refreshSignal, catalog, users, editable, onChanged, onDeleted }: EditorProps) {
  const [group, setGroup] = useState<AccessGroupDto | null>(null);
  const [drafts, setDrafts] = useState<GroupDrafts>({ name: '', description: '', permissions: [], scopes: {}, memberIds: [] });
  const { name, description, permissions, scopes, memberIds } = drafts;
  const setDraft = <K extends keyof GroupDrafts>(key: K, value: GroupDrafts[K] | ((current: GroupDrafts[K]) => GroupDrafts[K])) =>
    setDrafts((current) => ({ ...current, [key]: typeof value === 'function' ? (value as (v: GroupDrafts[K]) => GroupDrafts[K])(current[key]) : value }));
  const [search, setSearch] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  // One command at a time per group (its conflict reload included); reads apply only if nothing newer started.
  const commands = useRef(createCommandLock()).current;
  const reads = useRef(createRequestGenerations()).current;
  const keys = useRef({
    meta: createActionKeyStore(newAccessGroupsActionKey),
    active: createActionKeyStore(newAccessGroupsActionKey),
    permissions: createActionKeyStore(newAccessGroupsActionKey),
    members: createActionKeyStore(newAccessGroupsActionKey),
    remove: createActionKeyStore(newAccessGroupsActionKey),
  }).current;

  // The server state the drafts were made from, and the drafts of the last render (inputs are locked during a command,
  // so after its answer they are what the user had): the conflict merge needs both.
  const baseRef = useRef<AccessGroupDto | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  /** The server's group after `section` was saved (or loaded): only that section's drafts follow it. */
  const apply = useCallback((next: AccessGroupDto, section: GroupSection) => {
    baseRef.current = next;
    setGroup(next);
    setDrafts((current) => draftsAfterSave(section, next, current));
  }, []);

  /** After a conflict: three-way merge per section (draftsAfterConflict); edits that clashed are dropped and named. */
  const applyAfterConflict = useCallback((next: AccessGroupDto) => {
    const base = baseRef.current ?? next;
    const merged = draftsAfterConflict(base, next, draftsRef.current);
    baseRef.current = next;
    setGroup(next);
    setDrafts(merged.drafts);
    if (merged.discarded.length > 0) {
      const names: Record<DraftSection, string> = { meta: 'название', permissions: 'права и области', members: 'участники' };
      message.warning(`Группу изменили в другой сессии: ваши несохранённые правки (${merged.discarded.map((section) => names[section]).join(', ')}) заменены текущими данными.`);
    }
  }, []);

  const reload = useCallback(async (mode: 'all' | 'conflict' = 'all') => {
    await readLatest(reads, () => accessGroupsApi.get(groupId), (next) => (mode === 'conflict' ? applyAfterConflict(next) : apply(next, 'all')),
      (error) => message.error(accessGroupsErrorText(error, 'Не удалось загрузить группу')));
  }, [apply, applyAfterConflict, groupId, reads]);

  useEffect(() => {
    void reload('all');
  }, [reload]);

  // «Обновить»: not while a command runs (it invalidates reads and reloads itself on a conflict).
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === firstSignal.current || commands.busy) return;
    void reload('conflict');
  }, [commands, refreshSignal, reload]);

  const roleNames = useMemo(() => new Map(catalog.roles.map((role) => [role.roleCode, role.roleName || role.roleCode])), [catalog]);
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const domains = useMemo(
    () => permissionsByDomain(catalog.permissions, search, onlySelected ? new Set(permissions) : undefined),
    [catalog, search, onlySelected, permissions],
  );
  const draftMembers = useMemo(
    () => memberIds.map((userId) => {
      const known = group?.members.find((member) => member.userId === userId);
      const user = usersById.get(userId);
      // `held`: what the user already has (role, while groups are off) — the group adds nothing there.
      return {
        userId,
        username: user?.fullName || user?.username || known?.username || String(userId),
        roleCode: user?.role ?? known?.roleCode ?? null,
        held: user?.permissions ?? [],
      };
    }),
    [group, memberIds, usersById],
  );
  const warnings = useMemo(() => memberHasuraWarnings(permissions, draftMembers), [permissions, draftMembers]);

  if (!group) return <Card size="small" loading />;

  // One command at a time per group: every command compares the same group version.
  const busy = saving !== null;
  const metaDirty = name.trim() !== group.name || (description.trim() || null) !== (group.description ?? null);
  const permissionsDirty = !sameSet(permissions, group.permissions) || !sameScopes(scopes, group.scopes);
  const membersDirty = !sameSet(memberIds, group.members.map((member) => member.userId));

  async function run<T>(section: string, action: () => Promise<T>, done: (value: T) => void, success: string, handled?: (error: unknown) => boolean) {
    // The lock (not the state) refuses a second start before the re-render; the conflict reload runs inside it.
    await commands.run(async () => {
      setSaving(section);
      // A read sent before this command must not overwrite its answer.
      reads.begin();
      try {
        const value = await action();
        reads.begin();
        done(value);
        message.success(success);
        onChanged();
      } catch (error) {
        if (handled?.(error)) return;
        message.error(accessGroupsErrorText(error));
        // Changed meanwhile: the new version; untouched sections follow the server, own edits stay unless they clash.
        if (isStaleConflict(error)) await reload('conflict');
      } finally {
        setSaving(null);
      }
    });
  }

  function saveMeta() {
    const request = { version: group!.version, name: name.trim(), description: description.trim() || null };
    const key = keys.meta.keyFor(request);
    void run('meta', () => accessGroupsApi.update(groupId, request, key), (next) => {
      keys.meta.succeeded(key);
      apply(next, 'meta');
    }, 'Группа сохранена');
  }

  /** Only the activity: unsaved name or description stay drafts. */
  function saveActive(isActive: boolean) {
    const request = { version: group!.version, isActive };
    const key = keys.active.keyFor(request);
    void run('active', () => accessGroupsApi.update(groupId, request, key), (next) => {
      keys.active.succeeded(key);
      apply(next, 'active');
    }, isActive ? 'Группа включена' : 'Группа выключена');
  }

  function savePermissions(confirmDangerous: boolean) {
    const request = { version: group!.version, permissions, scopes: normalizeGroupScopes(scopes), confirmDangerous };
    const key = keys.permissions.keyFor(request);
    void run('permissions', () => accessGroupsApi.replacePermissions(groupId, request, key), (next) => {
      keys.permissions.succeeded(key);
      apply(next, 'permissions');
    }, 'Права группы сохранены', (error) => {
      // The server knows the dangerous list (the catalog here may be older): ask, then send with the confirmation.
      if (confirmDangerous || !(error instanceof ApiError) || error.code !== 'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED') return false;
      const listed = isRecord(error.details) && Array.isArray(error.details.permissions) ? error.details.permissions.map(String) : [];
      confirmDangerousSave(listed.length > 0 ? listed : addedDangerous(catalog.permissions, group!.permissions, permissions));
      return true;
    });
  }

  function handleSavePermissions() {
    const dangerous = addedDangerous(catalog.permissions, group!.permissions, permissions);
    if (dangerous.length === 0) {
      savePermissions(false);
      return;
    }
    confirmDangerousSave(dangerous);
  }

  function confirmDangerousSave(dangerous: string[]) {
    const labels = new Map(catalog.permissions.map((permission) => [permission.name, permission.label]));
    Modal.confirm({
      title: 'Подтвердите опасные права',
      content: (
        <Space direction="vertical" size={4}>
          {dangerous.map((permission) => <Text key={permission}>{labels.get(permission) ?? permission} ({permission})</Text>)}
        </Space>
      ),
      okText: 'Сохранить',
      cancelText: 'Отмена',
      onOk: () => savePermissions(true),
    });
  }

  function saveMembers() {
    const request = { version: group!.version, userIds: [...memberIds].sort((a, b) => a - b) };
    const key = keys.members.keyFor(request);
    void run('members', () => accessGroupsApi.replaceMembers(groupId, request, key), (next) => {
      keys.members.succeeded(key);
      apply(next, 'members');
    }, 'Участники сохранены');
  }

  function removeGroup() {
    const key = keys.remove.keyFor({ groupId, version: group!.version });
    void run('remove', () => accessGroupsApi.remove(groupId, group!.version, key), () => {
      keys.remove.succeeded(key);
      onDeleted();
    }, 'Группа удалена');
  }

  function togglePermission(permission: string, checked: boolean) {
    setDraft('permissions', (current) => (checked ? [...new Set([...current, permission])] : current.filter((item) => item !== permission)));
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <Text strong>{group.name}</Text>
            <Text type="secondary">{group.code}</Text>
            {group.isActive ? <Tag color="green">активна</Tag> : <Tag>выключена</Tag>}
          </Space>
        }
        extra={editable && (
          <Space>
            <Switch
              checkedChildren="активна"
              unCheckedChildren="выключена"
              checked={group.isActive}
              loading={saving === 'active'}
              disabled={busy}
              onChange={(checked) => saveActive(checked)}
            />
            <Popconfirm
              title="Удалить группу? Удалить можно только выключенную группу без участников."
              okText="Удалить"
              cancelText="Отмена"
              disabled={group.isActive || group.members.length > 0 || busy}
              onConfirm={removeGroup}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={group.isActive || group.members.length > 0 || busy}>
                Удалить
              </Button>
            </Popconfirm>
          </Space>
        )}
      >
        <Row gutter={[12, 8]}>
          <Col xs={24} md={10}>
            <Input value={name} onChange={(event) => setDraft('name', event.target.value)} maxLength={120} disabled={!editable || busy} addonBefore="Название" />
          </Col>
          <Col xs={24} md={14}>
            <Input value={description} onChange={(event) => setDraft('description', event.target.value)} maxLength={1000} disabled={!editable || busy} addonBefore="Описание" />
          </Col>
        </Row>
        {editable && metaDirty && (
          <Button style={{ marginTop: 8 }} size="small" type="primary" icon={<SaveOutlined />} loading={saving === 'meta'}
            disabled={!name.trim() || busy} onClick={() => saveMeta()}>
            Сохранить название
          </Button>
        )}
      </Card>

      <Card
        size="small"
        title={`Права группы (${permissions.length})`}
        extra={editable && (
          <Button size="small" type="primary" icon={<SaveOutlined />} disabled={!permissionsDirty || busy}
            loading={saving === 'permissions'} onClick={handleSavePermissions}>
            Сохранить права
          </Button>
        )}
      >
        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search allowClear placeholder="Поиск права" style={{ width: 240 }} value={search} onChange={(event) => setSearch(event.target.value)} />
          <Checkbox checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)}>Только выбранные</Checkbox>
        </Space>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {domains.length === 0 && <Empty description="Нет прав" />}
          {domains.map(({ domain, permissions: domainPermissions }) => (
            <div key={domain} style={{ marginBottom: 8 }}>
              <Tag>{domain}</Tag>
              <Row gutter={[8, 2]}>
                {domainPermissions.map((permission) => (
                  <Col key={permission.name} xs={24} md={12}>
                    <Checkbox
                      checked={permissions.includes(permission.name)}
                      disabled={!editable || busy}
                      onChange={(event) => togglePermission(permission.name, event.target.checked)}
                    >
                      <Text>{permission.label}</Text>{' '}
                      <Text type="secondary" style={{ fontSize: 12 }}>{permission.name}</Text>
                      {permission.isDangerous && <Tag color="red" style={{ marginLeft: 4 }}>опасное</Tag>}
                    </Checkbox>
                  </Col>
                ))}
              </Row>
            </div>
          ))}
        </div>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
          Зависимые права добавятся при сохранении сами (как в матрице ролей).
        </Paragraph>
        <Text strong>Области</Text>
        <Row gutter={[12, 8]} style={{ marginTop: 4 }}>
          {catalog.scopeKeys.map((scopeKey) => (
            <Col key={scopeKey.key} xs={24} md={12}>
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{scopeKey.label || scopeKey.key}</Text>
                <Select
                  mode="multiple"
                  allowClear
                  size="small"
                  style={{ width: '100%' }}
                  placeholder="не даёт"
                  disabled={!editable || busy}
                  value={scopes[scopeKey.key] ?? []}
                  options={groupScopeValues(scopeKey).map((value) => ({ value, label: SCOPE_VALUE_LABELS[value] ?? value }))}
                  onChange={(values: string[]) => setDraft('scopes', (current) => ({ ...current, [scopeKey.key]: values }))}
                />
              </Space>
            </Col>
          ))}
        </Row>
      </Card>

      <Card
        size="small"
        title={`Участники (${memberIds.length})`}
        extra={editable && (
          <Button size="small" type="primary" icon={<SaveOutlined />} disabled={!membersDirty || busy}
            loading={saving === 'members'} onClick={saveMembers}>
            Сохранить участников
          </Button>
        )}
      >
        <Select
          mode="multiple"
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="Добавьте пользователей"
          disabled={!editable || busy}
          value={memberIds}
          onChange={(values: number[]) => setDraft('memberIds', values)}
          options={[
            ...users
              .filter((user) => user.isActive || memberIds.includes(user.id))
              .map((user) => ({
                value: user.id,
                label: `${user.fullName || user.username} — ${roleNames.get(user.role) ?? user.role}${user.isActive ? '' : ' (отключён)'}`,
              })),
            // Without the user list (no users.view) the current members still show by name.
            ...group.members
              .filter((member) => !usersById.has(member.userId))
              .map((member) => ({ value: member.userId, label: `${member.username} — ${roleNames.get(member.roleCode ?? '') ?? member.roleCode ?? '—'}` })),
          ]}
        />
        {warnings.length > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="Не всё сработает в разделах, которые читают базу напрямую (Hasura)"
            description={
              <Space direction="vertical" size={2}>
                {warnings.map((warning) => (
                  <Text key={warning.userId} style={{ fontSize: 12 }}>
                    {warning.username} (роль {roleNames.get(warning.roleCode ?? '') ?? warning.roleCode ?? '—'}):{' '}
                    {warning.gaps.map((gap) => `${gap.permission} → нет ${gap.targets.join(', ')}`).join('; ')}
                  </Text>
                ))}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Группа не расширяет профиль роли в Hasura. Права, которые проверяет backend, работают для всех.
                </Text>
              </Space>
            }
          />
        )}
      </Card>
    </Space>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
