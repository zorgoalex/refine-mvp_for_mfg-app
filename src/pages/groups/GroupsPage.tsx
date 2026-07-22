import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { groupsApi } from '../../api/groupsApi';
import type {
  CreateGroupRequest,
  GroupDeadlineStatusCountsResponse,
  GroupDto,
  GroupEntityLinksResponse,
  GroupOverviewResponse,
  GroupParticipantRolesResponse,
  GroupParticipantsResponse,
  GroupStatus,
  ReplaceGroupEntityLink,
  ReplaceGroupParticipant,
} from '../../api/types/groupApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can, canAll } from '../../utils/permissions';
import type { UserIdentity } from '../../types/auth';
import { canViewGroupsPage } from '../../utils/groupAccess';
import { GroupDetailOverview } from './GroupDetailOverview';
import { GroupEntityLinksPanel } from './GroupEntityLinksPanel';
import { GroupParticipantsPanel } from './GroupParticipantsPanel';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';

const { Title } = Typography;

const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  paused: 'Пауза',
  completed: 'Завершен',
  archived: 'Архив',
};

const MUTABLE_STATUS_OPTIONS: Array<{ label: string; value: GroupStatus }> = [
  { label: 'Черновик', value: 'draft' },
  { label: 'Активен', value: 'active' },
  { label: 'Пауза', value: 'paused' },
  { label: 'Завершен', value: 'completed' },
];

interface GroupFormValues {
  code: string;
  name: string;
  description?: string;
  status?: GroupStatus;
  startsAt?: { format: (format: string) => string } | null;
  endsAt?: { format: (format: string) => string } | null;
}

interface GroupsPageProps {
  initialGroups?: GroupDto[];
  initialOverview?: GroupOverviewResponse | null;
  initialEntityLinks?: GroupEntityLinksResponse | null;
  initialParticipants?: GroupParticipantsResponse | null;
  initialParticipantRoles?: GroupParticipantRolesResponse | null;
  initialDeadlineStatusCounts?: GroupDeadlineStatusCountsResponse | null;
}

export interface OverviewSelectionState {
  activeRequestId: number;
  loadingGroupId: string | null;
  overview: GroupOverviewResponse | null;
}

type OverviewSelectionAction =
  | { type: 'request'; groupId: string; requestId?: number }
  | { type: 'success'; requestId: number; overview: GroupOverviewResponse }
  | { type: 'failure'; requestId: number }
  | { type: 'close' };

export function getNextOverviewSelectionState(
  state: OverviewSelectionState,
  action: OverviewSelectionAction,
): OverviewSelectionState {
  switch (action.type) {
    case 'request': {
      const requestId = action.requestId ?? state.activeRequestId + 1;
      return {
        activeRequestId: requestId,
        loadingGroupId: action.groupId,
        overview: null,
      };
    }
    case 'success':
      if (action.requestId !== state.activeRequestId || state.loadingGroupId === null) {
        return state;
      }

      return {
        activeRequestId: state.activeRequestId,
        loadingGroupId: null,
        overview: action.overview,
      };
    case 'failure':
      if (action.requestId !== state.activeRequestId) {
        return state;
      }

      return {
        activeRequestId: state.activeRequestId,
        loadingGroupId: null,
        overview: state.overview,
      };
    case 'close':
      return {
        activeRequestId: state.activeRequestId + 1,
        loadingGroupId: null,
        overview: null,
      };
    default:
      return state;
  }
}

export const GroupsPage: React.FC<GroupsPageProps> = ({
  initialGroups = [],
  initialOverview = null,
  initialEntityLinks = null,
  initialParticipants = null,
  initialParticipantRoles = null,
  initialDeadlineStatusCounts = null,
}) => {
  const { pageSize, setPageSize } = usePageSizePreference('groups:list', 25);
  const [groupPage, setGroupPage] = useState(1);
  const [groupTotal, setGroupTotal] = useState(initialGroups?.length ?? 0);
  const [form] = Form.useForm<GroupFormValues>();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const [groups, setGroups] = useState<GroupDto[]>(initialGroups);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [overviewSelection, setOverviewSelection] = useState<OverviewSelectionState>({
    activeRequestId: 0,
    loadingGroupId: null,
    overview: initialOverview,
  });
  const [entityLinks, setEntityLinks] = useState<GroupEntityLinksResponse | null>(initialEntityLinks);
  const [participants, setParticipants] = useState<GroupParticipantsResponse | null>(initialParticipants);
  const [participantRoles, setParticipantRoles] = useState<GroupParticipantRolesResponse | null>(
    initialParticipantRoles,
  );
  const [deadlineStatusCounts, setDeadlineStatusCounts] =
    useState<GroupDeadlineStatusCountsResponse | null>(initialDeadlineStatusCounts);
  const overviewRequestIdRef = useRef(0);

  const currentUser = identity ?? null;
  const canView = canViewGroupsPage(featureFlags, currentUser);
  const canCreate = !featureFlags.useBackendPermissions || can('groups.create', currentUser);
  const canArchive = !featureFlags.useBackendPermissions || can('groups.archive', currentUser);
  const canViewOverview = !featureFlags.useBackendPermissions || canAll(['groups.view', 'orders.view'], currentUser);
  const canViewEntityLinks = !featureFlags.useBackendPermissions || can('groups.view', currentUser);
  const canManageEntityLinks = !featureFlags.useBackendPermissions || can('groups.manage_links', currentUser);
  const canViewParticipants = !featureFlags.useBackendPermissions || can('groups.participants.view', currentUser);
  const canManageParticipants = !featureFlags.useBackendPermissions || can('groups.participants.manage', currentUser);
  const canViewDeadlineStatusCounts =
    !featureFlags.useBackendPermissions ||
    canAll(['groups.view', 'orders.view', 'deadlines.view'], currentUser);

  const loadGroups = useCallback(async () => {
    if (!canView) return;

    setLoading(true);
    try {
      const response = await groupsApi.listGroups({ page: groupPage, pageSize, includeArchived: true });
      setGroups(response.data);
      setGroupTotal(response.pagination.total);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить группы');
    } finally {
      setLoading(false);
    }
  }, [canView, groupPage, pageSize]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!canViewDeadlineStatusCounts) {
      setDeadlineStatusCounts(null);
    }
  }, [canViewDeadlineStatusCounts]);

  const handleCreate = async (values: GroupFormValues) => {
    setCreating(true);
    try {
      await groupsApi.createGroup(mapCreateRequest(values));
      form.resetFields();
      await loadGroups();
      message.success('Группа создана');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось создать группу');
    } finally {
      setCreating(false);
    }
  };

  const handleArchive = useCallback(async (groupId: string) => {
    setArchivingId(groupId);
    try {
      await groupsApi.archiveGroup(groupId);
      await loadGroups();
      message.success('Группа архивирована');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось архивировать группу');
    } finally {
      setArchivingId(null);
    }
  }, [loadGroups]);

  const handleAuxiliaryLoadError = useCallback((error: unknown, requestId: number): null => {
    if (overviewRequestIdRef.current === requestId) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить данные группы');
    }
    return null;
  }, []);

  const handleOverview = useCallback(async (groupId: string) => {
    const requestId = overviewRequestIdRef.current + 1;
    overviewRequestIdRef.current = requestId;
    setOverviewSelection((state) => getNextOverviewSelectionState(state, {
      type: 'request',
      groupId,
      requestId,
    }));

    try {
      const [response, linksResponse, participantsResponse, rolesResponse, deadlineResponse] = await Promise.all([
        groupsApi.getGroupOverview(groupId),
        canViewEntityLinks
          ? groupsApi.getGroupEntityLinks(groupId).catch((error) => handleAuxiliaryLoadError(error, requestId))
          : Promise.resolve(null),
        canViewParticipants
          ? groupsApi.getGroupParticipants(groupId).catch((error) => handleAuxiliaryLoadError(error, requestId))
          : Promise.resolve(null),
        canViewParticipants
          ? groupsApi.getGroupParticipantRoles().catch((error) => handleAuxiliaryLoadError(error, requestId))
          : Promise.resolve(null),
        canViewDeadlineStatusCounts
          ? groupsApi.getGroupDeadlineStatusCounts({
              groupMode: 'any',
              groupIds: [groupId],
              temporalMode: 'current',
            }).catch((error) => handleAuxiliaryLoadError(error, requestId))
          : Promise.resolve(null),
      ]);
      setOverviewSelection((state) => getNextOverviewSelectionState(state, {
        type: 'success',
        requestId,
        overview: response,
      }));
      if (overviewRequestIdRef.current === requestId) {
        setEntityLinks(linksResponse);
        setParticipants(participantsResponse);
        setParticipantRoles(rolesResponse);
        setDeadlineStatusCounts(deadlineResponse);
      }
    } catch (error) {
      if (overviewRequestIdRef.current === requestId) {
        message.error(error instanceof Error ? error.message : 'Не удалось загрузить обзор группы');
      }
      setOverviewSelection((state) => getNextOverviewSelectionState(state, {
        type: 'failure',
        requestId,
      }));
    }
  }, [
    canViewDeadlineStatusCounts,
    canViewEntityLinks,
    canViewParticipants,
    handleAuxiliaryLoadError,
  ]);

  const handleCloseOverview = useCallback(() => {
    overviewRequestIdRef.current += 1;
    setOverviewSelection((state) => getNextOverviewSelectionState(state, { type: 'close' }));
    setEntityLinks(null);
    setParticipants(null);
    setParticipantRoles(null);
    setDeadlineStatusCounts(null);
  }, []);

  const handleAppendEntityLink = useCallback(async (link: ReplaceGroupEntityLink) => {
    const groupId = overviewSelection.overview?.group.id;
    if (!groupId) return;

    try {
      const response = await groupsApi.appendGroupEntityLinks(groupId, {
        idempotencyKey: createGroupIdempotencyKey('group-entity-links'),
        links: [link],
      });
      setEntityLinks(response);
      message.success('Связь группы добавлена');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить связь группы');
    }
  }, [overviewSelection.overview?.group.id]);

  const handleReplaceParticipants = useCallback(async (nextParticipants: ReplaceGroupParticipant[]) => {
    const groupId = overviewSelection.overview?.group.id;
    if (!groupId) return;

    try {
      const response = await groupsApi.replaceGroupParticipants(groupId, {
        idempotencyKey: createGroupIdempotencyKey('group-participants'),
        participants: nextParticipants,
      });
      setParticipants(response);
      message.success('Участники группы сохранены');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить участников группы');
    }
  }, [overviewSelection.overview?.group.id]);

  const columns = useMemo<ColumnsType<GroupDto>>(
    () => [
      {
        title: 'Код',
        dataIndex: 'code',
        key: 'code',
        width: 140,
      },
      {
        title: 'Название',
        dataIndex: 'name',
        key: 'name',
      },
      {
        title: 'Статус',
        dataIndex: 'status',
        key: 'status',
        width: 130,
        render: (status: GroupStatus) => <Tag>{GROUP_STATUS_LABELS[status] ?? status}</Tag>,
      },
      {
        title: 'Даты',
        key: 'dates',
        width: 180,
        render: (_, group) => [group.startsAt, group.endsAt].filter(Boolean).join(' - ') || '-',
      },
      {
        title: '',
        key: 'actions',
        width: 260,
        render: (_, group) => (
          <Space>
            {canViewOverview ? (
              <Button
                loading={overviewSelection.loadingGroupId === group.id}
                onClick={() => void handleOverview(group.id)}
              >
                Обзор
              </Button>
            ) : null}
            <Button
              danger
              disabled={!canArchive || group.status === 'archived'}
              loading={archivingId === group.id}
              onClick={() => void handleArchive(group.id)}
            >
              Архивировать
            </Button>
          </Space>
        ),
      },
    ],
    [archivingId, canArchive, canViewOverview, handleArchive, handleOverview, overviewSelection.loadingGroupId],
  );

  if (!canView) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="warning"
          showIcon
          message="Нет доступа к группым"
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>Группы</Title>
      <Form
        form={form}
        layout="inline"
        onFinish={handleCreate}
        style={{ marginBottom: 16, rowGap: 8 }}
      >
        <Form.Item
          name="code"
          label="Код группы"
          rules={[{ required: true }, { pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/ }]}
        >
          <Input disabled={!canCreate} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="name" label="Название" rules={[{ required: true, max: 256 }]}>
          <Input disabled={!canCreate} style={{ width: 220 }} />
        </Form.Item>
        <Form.Item name="status" initialValue="active">
          <Select disabled={!canCreate} options={MUTABLE_STATUS_OPTIONS} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="startsAt">
          <DatePicker disabled={!canCreate} placeholder="Начало" />
        </Form.Item>
        <Form.Item name="endsAt">
          <DatePicker disabled={!canCreate} placeholder="Конец" />
        </Form.Item>
        <Form.Item name="description">
          <Input disabled={!canCreate} placeholder="Описание" style={{ width: 220 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" disabled={!canCreate} loading={creating}>
            Создать
          </Button>
        </Form.Item>
      </Form>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={groups}
          loading={loading}
          pagination={{
            current: groupPage,
            pageSize,
            total: groupTotal,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            showTotal: (total) => `Всего: ${total}`,
            onChange: (nextPage, nextPageSize) => {
              if (nextPageSize !== pageSize) {
                setPageSize(nextPageSize);
                setGroupPage(1);
                return;
              }
              setGroupPage(nextPage);
            },
          }}
        />
        {overviewSelection.overview ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Button onClick={handleCloseOverview}>Закрыть</Button>
            <GroupDetailOverview
              overview={overviewSelection.overview}
              deadlineStatusCounts={
                canViewDeadlineStatusCounts
                  ? getMatchingDeadlineStatusCounts(overviewSelection.overview.group.id, deadlineStatusCounts)
                  : null
              }
            />
            {canViewEntityLinks ? (
              <GroupEntityLinksPanel
                response={entityLinks}
                currentUser={currentUser}
                canManage={canManageEntityLinks}
                onAppend={(link) => void handleAppendEntityLink(link)}
              />
            ) : null}
            {canViewParticipants ? (
              <GroupParticipantsPanel
                response={participants}
                roles={participantRoles?.roles ?? []}
                canManage={canManageParticipants}
                onReplace={(nextParticipants) => void handleReplaceParticipants(nextParticipants)}
              />
            ) : null}
          </Space>
        ) : null}
      </Space>
    </div>
  );
};

function mapCreateRequest(values: GroupFormValues): CreateGroupRequest {
  return {
    code: values.code.trim(),
    name: values.name.trim(),
    description: values.description?.trim() || null,
    status: values.status ?? 'active',
    startsAt: values.startsAt?.format('YYYY-MM-DD') ?? null,
    endsAt: values.endsAt?.format('YYYY-MM-DD') ?? null,
  };
}

function createGroupIdempotencyKey(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${uuid}`;
}

export function getMatchingDeadlineStatusCounts(
  groupId: string,
  response: GroupDeadlineStatusCountsResponse | null,
): GroupDeadlineStatusCountsResponse | null {
  if (!response || response.filter.groupMode === 'none') return null;
  return response.filter.groupIds.length === 1 && response.filter.groupIds[0] === groupId
    ? response
    : null;
}
