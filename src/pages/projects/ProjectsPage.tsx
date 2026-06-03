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
import { projectsApi } from '../../api/projectsApi';
import type {
  CreateProjectRequest,
  ProjectDto,
  ProjectOverviewResponse,
  ProjectStatus,
} from '../../api/types/projectApi.types';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import type { UserIdentity } from '../../types/auth';
import { canViewProjectsPage } from '../../utils/projectAccess';
import { ProjectDetailOverview } from './ProjectDetailOverview';

const { Title } = Typography;

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  paused: 'Пауза',
  completed: 'Завершен',
  archived: 'Архив',
};

const MUTABLE_STATUS_OPTIONS: Array<{ label: string; value: ProjectStatus }> = [
  { label: 'Черновик', value: 'draft' },
  { label: 'Активен', value: 'active' },
  { label: 'Пауза', value: 'paused' },
  { label: 'Завершен', value: 'completed' },
];

interface ProjectFormValues {
  code: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  startsAt?: { format: (format: string) => string } | null;
  endsAt?: { format: (format: string) => string } | null;
}

interface ProjectsPageProps {
  initialProjects?: ProjectDto[];
  initialOverview?: ProjectOverviewResponse | null;
}

export interface OverviewSelectionState {
  activeRequestId: number;
  loadingProjectId: string | null;
  overview: ProjectOverviewResponse | null;
}

type OverviewSelectionAction =
  | { type: 'request'; projectId: string; requestId?: number }
  | { type: 'success'; requestId: number; overview: ProjectOverviewResponse }
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
        loadingProjectId: action.projectId,
        overview: null,
      };
    }
    case 'success':
      if (action.requestId !== state.activeRequestId || state.loadingProjectId === null) {
        return state;
      }

      return {
        activeRequestId: state.activeRequestId,
        loadingProjectId: null,
        overview: action.overview,
      };
    case 'failure':
      if (action.requestId !== state.activeRequestId) {
        return state;
      }

      return {
        activeRequestId: state.activeRequestId,
        loadingProjectId: null,
        overview: state.overview,
      };
    case 'close':
      return {
        activeRequestId: state.activeRequestId + 1,
        loadingProjectId: null,
        overview: null,
      };
    default:
      return state;
  }
}

export const ProjectsPage: React.FC<ProjectsPageProps> = ({
  initialProjects = [],
  initialOverview = null,
}) => {
  const [form] = Form.useForm<ProjectFormValues>();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const [projects, setProjects] = useState<ProjectDto[]>(initialProjects);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [overviewSelection, setOverviewSelection] = useState<OverviewSelectionState>({
    activeRequestId: 0,
    loadingProjectId: null,
    overview: initialOverview,
  });
  const overviewRequestIdRef = useRef(0);

  const currentUser = identity ?? null;
  const canView = canViewProjectsPage(featureFlags, currentUser);
  const canCreate = !featureFlags.useBackendPermissions || can('projects.create', currentUser);
  const canArchive = !featureFlags.useBackendPermissions || can('projects.archive', currentUser);

  const loadProjects = useCallback(async () => {
    if (!canView) return;

    setLoading(true);
    try {
      const response = await projectsApi.listProjects({ page: 1, pageSize: 50, includeArchived: true });
      setProjects(response.data);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleCreate = async (values: ProjectFormValues) => {
    setCreating(true);
    try {
      await projectsApi.createProject(mapCreateRequest(values));
      form.resetFields();
      await loadProjects();
      message.success('Проект создан');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось создать проект');
    } finally {
      setCreating(false);
    }
  };

  const handleArchive = useCallback(async (projectId: string) => {
    setArchivingId(projectId);
    try {
      await projectsApi.archiveProject(projectId);
      await loadProjects();
      message.success('Проект архивирован');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось архивировать проект');
    } finally {
      setArchivingId(null);
    }
  }, [loadProjects]);

  const handleOverview = useCallback(async (projectId: string) => {
    const requestId = overviewRequestIdRef.current + 1;
    overviewRequestIdRef.current = requestId;
    setOverviewSelection((state) => getNextOverviewSelectionState(state, {
      type: 'request',
      projectId,
      requestId,
    }));

    try {
      const response = await projectsApi.getProjectOverview(projectId);
      setOverviewSelection((state) => getNextOverviewSelectionState(state, {
        type: 'success',
        requestId,
        overview: response,
      }));
    } catch (error) {
      if (overviewRequestIdRef.current === requestId) {
        message.error(error instanceof Error ? error.message : 'Не удалось загрузить обзор проекта');
      }
      setOverviewSelection((state) => getNextOverviewSelectionState(state, {
        type: 'failure',
        requestId,
      }));
    }
  }, []);

  const handleCloseOverview = useCallback(() => {
    overviewRequestIdRef.current += 1;
    setOverviewSelection((state) => getNextOverviewSelectionState(state, { type: 'close' }));
  }, []);

  const columns = useMemo<ColumnsType<ProjectDto>>(
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
        render: (status: ProjectStatus) => <Tag>{PROJECT_STATUS_LABELS[status] ?? status}</Tag>,
      },
      {
        title: 'Даты',
        key: 'dates',
        width: 180,
        render: (_, project) => [project.startsAt, project.endsAt].filter(Boolean).join(' - ') || '-',
      },
      {
        title: '',
        key: 'actions',
        width: 260,
        render: (_, project) => (
          <Space>
            <Button
              loading={overviewSelection.loadingProjectId === project.id}
              onClick={() => void handleOverview(project.id)}
            >
              Обзор
            </Button>
            <Button
              danger
              disabled={!canArchive || project.status === 'archived'}
              loading={archivingId === project.id}
              onClick={() => void handleArchive(project.id)}
            >
              Архивировать
            </Button>
          </Space>
        ),
      },
    ],
    [archivingId, canArchive, handleArchive, handleOverview, overviewSelection.loadingProjectId],
  );

  if (!canView) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="warning"
          showIcon
          message="Нет доступа к проектам"
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>Проекты</Title>
      <Form
        form={form}
        layout="inline"
        onFinish={handleCreate}
        style={{ marginBottom: 16, rowGap: 8 }}
      >
        <Form.Item
          name="code"
          label="Код проекта"
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
          dataSource={projects}
          loading={loading}
          pagination={{ pageSize: 25 }}
        />
        {overviewSelection.overview ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Button onClick={handleCloseOverview}>Закрыть</Button>
            <ProjectDetailOverview overview={overviewSelection.overview} />
          </Space>
        ) : null}
      </Space>
    </div>
  );
};

function mapCreateRequest(values: ProjectFormValues): CreateProjectRequest {
  return {
    code: values.code.trim(),
    name: values.name.trim(),
    description: values.description?.trim() || null,
    status: values.status ?? 'active',
    startsAt: values.startsAt?.format('YYYY-MM-DD') ?? null,
    endsAt: values.endsAt?.format('YYYY-MM-DD') ?? null,
  };
}
