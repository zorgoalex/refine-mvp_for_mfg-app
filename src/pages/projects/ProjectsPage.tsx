import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  ProjectStatus,
} from '../../api/types/projectApi.types';
import { authSession } from '../../api/authSession';
import { featureFlags } from '../../config/featureFlags';
import { authStorage } from '../../utils/auth';
import { can } from '../../utils/permissions';

const { Title } = Typography;

const STATUS_OPTIONS: Array<{ label: string; value: ProjectStatus }> = [
  { label: 'Черновик', value: 'draft' },
  { label: 'Активен', value: 'active' },
  { label: 'Пауза', value: 'paused' },
  { label: 'Завершен', value: 'completed' },
  { label: 'Архив', value: 'archived' },
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
}

export const ProjectsPage: React.FC<ProjectsPageProps> = ({ initialProjects = [] }) => {
  const [form] = Form.useForm<ProjectFormValues>();
  const [projects, setProjects] = useState<ProjectDto[]>(initialProjects);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const currentUser = getCurrentProjectUser();
  const canCreate = !featureFlags.useBackendPermissions || can('projects.create', currentUser);
  const canArchive = !featureFlags.useBackendPermissions || can('projects.archive', currentUser);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await projectsApi.listProjects({ page: 1, pageSize: 50, includeArchived: true });
      setProjects(response.data);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const handleArchive = async (projectId: string) => {
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
  };

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
        render: (status: ProjectStatus) => <Tag>{STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status}</Tag>,
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
        width: 150,
        render: (_, project) => (
          <Button
            danger
            disabled={!canArchive || project.status === 'archived'}
            loading={archivingId === project.id}
            onClick={() => void handleArchive(project.id)}
          >
            Архивировать
          </Button>
        ),
      },
    ],
    [archivingId, canArchive],
  );

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
          <Select disabled={!canCreate} options={STATUS_OPTIONS} style={{ width: 140 }} />
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

function getCurrentProjectUser() {
  if (featureFlags.useBackendPermissions) {
    return authSession.getUser();
  }

  if (typeof localStorage === 'undefined') {
    return null;
  }

  return authStorage.getUser();
}
