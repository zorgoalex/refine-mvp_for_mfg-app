import React, { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Space, Tag, Typography, Form, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { projectsApi } from '../../../../api/groupsApi';
import type { EntityProjectLink } from '../../../../api/types/groupApi.types';
import { featureFlags } from '../../../../config/featureFlags';
import { can } from '../../../../utils/permissions';
import { ProjectSelect } from './ProjectSelect';
import { ProjectHistoryTable } from './ProjectHistoryTable';

const { Text } = Typography;

interface ProjectLinksEditorProps {
  orderId: number;
  version: number;
  initialProjects?: EntityProjectLink[];
}

export const ProjectLinksEditor: React.FC<ProjectLinksEditorProps> = ({
  orderId,
  version,
  initialProjects = [],
}) => {
  const [projects, setProjects] = useState<EntityProjectLink[]>(initialProjects);
  const [linkVersion, setLinkVersion] = useState(version);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ projectIds: string[]; primaryProjectId?: string | null }>();
  const canManage = featureFlags.useBackendProjects && can('projects.manage_links');

  useEffect(() => {
    setProjects(initialProjects);
  }, [initialProjects]);

  useEffect(() => {
    setLinkVersion(version);
  }, [version]);

  useEffect(() => {
    if (!featureFlags.useBackendProjects || !orderId) return;
    let cancelled = false;
    void projectsApi.getOrderProjects(orderId).then((response) => {
      if (!cancelled) {
        setProjects(response.projects);
        setLinkVersion(response.version);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const primaryProject = projects.find((project) => project.isPrimary) ?? null;
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);

  const openEditor = () => {
    form.setFieldsValue({
      projectIds,
      primaryProjectId: primaryProject?.id ?? null,
    });
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    const ids = values.projectIds ?? [];
    if (values.primaryProjectId && !ids.includes(values.primaryProjectId)) {
      message.error('Главный проект должен быть выбран в списке проектов');
      return;
    }
    setSaving(true);
    try {
      const response = await projectsApi.replaceOrderProjects(orderId, {
        idempotencyKey: createIdempotencyKey(orderId),
        version: linkVersion,
        primaryProjectId: values.primaryProjectId ?? null,
        projects: ids.map((projectId) => {
          const existing = projects.find((project) => project.id === projectId);
          return {
            projectId,
            relationType: existing?.relationType ?? 'main',
            isPrimary: projectId === values.primaryProjectId,
          };
        }),
        reason: 'frontend-order-project-links-editor',
      });
      setProjects(response.projects);
      setLinkVersion(response.version);
      setOpen(false);
      message.success('Проекты заказа обновлены');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <Space wrap>
        <Text type="secondary">Проекты:</Text>
        {projects.length === 0 ? (
          <Tag>Проект не указан</Tag>
        ) : projects.map((project) => (
          <Tag key={`${project.id}:${project.relationType}`} color={project.isPrimary ? 'gold' : undefined}>
            {project.code} · {project.name}
          </Tag>
        ))}
        {canManage && (
          <Button size="small" icon={<EditOutlined />} onClick={openEditor}>
            Изменить
          </Button>
        )}
      </Space>

      <Modal
        title="Проекты заказа"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        okText="Сохранить"
        cancelText="Отмена"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="projectIds" label="Проекты">
            <ProjectSelect mode="multiple" selectedProjects={projects} />
          </Form.Item>
          <Form.Item name="primaryProjectId" label="Главный проект">
            <ProjectSelect selectedProjects={projects} />
          </Form.Item>
        </Form>
        <ProjectHistoryTable links={projects} />
      </Modal>
    </div>
  );
};

function createIdempotencyKey(orderId: number): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `order-projects:${orderId}:${uuid}`;
}
