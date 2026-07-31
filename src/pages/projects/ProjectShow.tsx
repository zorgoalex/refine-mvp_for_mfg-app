import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Typography, message, notification } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/apiError';
import { projectsApi } from '../../api/projectsApi';
import type { ProjectCard, ProjectDto, ProjectOrderSummary } from '../../api/projectsApi';
import { OrderDeletedTag, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { formatNumber } from '../../utils/numberFormat';
import { canMergeInto } from './projectHelpers';
import { filterOrderFinancialItems } from '../../utils/orderFinancialVisibility';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';

const { Title } = Typography;

interface ProjectFormValues {
  code: string;
  name: string;
  notes: string;
}

export const ProjectShow: React.FC = () => {
  const { canViewFinancials } = useOrderFinancialVisibility();
  const { id } = useParams();
  const projectId = Number(id);
  const isValidProjectId = Number.isInteger(projectId) && projectId > 0;
  const [form] = Form.useForm<ProjectFormValues>();
  const [project, setProject] = useState<ProjectCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<ProjectDto[]>([]);
  const [mergeCandidatesLoading, setMergeCandidatesLoading] = useState(false);
  const [selectedSourceProjectId, setSelectedSourceProjectId] = useState<number | undefined>(undefined);
  const [mergeSubmitting, setMergeSubmitting] = useState(false);

  const loadProject = useCallback(async () => {
    if (!isValidProjectId) {
      return;
    }

    setLoading(true);
    try {
      const response = await projectsApi.getById(projectId);
      setProject(response);
      form.setFieldsValue({
        code: response.code,
        name: response.name,
        notes: response.notes ?? '',
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить проект');
    } finally {
      setLoading(false);
    }
  }, [form, isValidProjectId, projectId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (!mergeModalOpen || project === null) {
      return;
    }

    let cancelled = false;

    const loadMergeCandidates = async () => {
      setMergeCandidatesLoading(true);
      try {
        const response = await projectsApi.list({ clientId: project.clientId });
        if (!cancelled) {
          setMergeCandidates(response.filter((candidate) => canMergeInto(project, candidate)));
        }
      } catch (error) {
        if (!cancelled) {
          message.error(error instanceof Error ? error.message : 'Не удалось загрузить список проектов');
        }
      } finally {
        if (!cancelled) {
          setMergeCandidatesLoading(false);
        }
      }
    };

    void loadMergeCandidates();

    return () => {
      cancelled = true;
    };
  }, [mergeModalOpen, project]);

  const handleSave = useCallback(async () => {
    if (project === null) {
      return;
    }

    const values = await form.validateFields();
    setSaving(true);
    try {
      await projectsApi.update(project.projectId, {
        code: values.code.trim(),
        name: values.name.trim(),
        notes: normalizeOptionalText(values.notes),
        expectedVersion: project.version,
      });
      await loadProject();
      message.success('Проект сохранён');
    } catch (error) {
      showProjectMutationError(error, 'Не удалось сохранить проект');
    } finally {
      setSaving(false);
    }
  }, [form, loadProject, project]);

  const handleMerge = useCallback(async () => {
    if (project === null || selectedSourceProjectId === undefined) {
      return;
    }

    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setMergeSubmitting(true);
    try {
      await projectsApi.merge(project.projectId, {
        sourceProjectId: selectedSourceProjectId,
        idempotencyKey,
      });
      setMergeModalOpen(false);
      setSelectedSourceProjectId(undefined);
      await loadProject();
      message.success('Проекты объединены');
    } catch (error) {
      showProjectMutationError(error, 'Не удалось объединить проекты');
    } finally {
      setMergeSubmitting(false);
    }
  }, [loadProject, project, selectedSourceProjectId]);

  const orderColumns = useMemo<ColumnsType<ProjectOrderSummary>>(
    () => filterOrderFinancialItems([
      {
        title: 'Номер',
        dataIndex: 'fullNumber',
        key: 'fullNumber',
        render: (value: string, record) => (
          <Space size={4} wrap>
            <Link to={`/orders/show/${record.orderId}`}>{value}</Link>
            <OrderDeletedTag deleted={record.deleteFlag} />
          </Space>
        ),
      },
      {
        title: 'Заказ',
        dataIndex: 'orderName',
        key: 'orderName',
      },
      {
        title: 'Сумма',
        dataIndex: 'finalAmount',
        key: 'finalAmount',
        width: 140,
        render: (value: string | null) => formatAmount(value),
      },
      {
        title: 'Оплата',
        dataIndex: 'paidAmount',
        key: 'paidAmount',
        width: 140,
        render: (value: string | null) => formatAmount(value),
      },
      {
        title: 'Статус',
        dataIndex: 'orderStatusName',
        key: 'orderStatusName',
        render: (value: string | null) => value || '—',
      },
    ], canViewFinancials),
    [canViewFinancials],
  );

  const mergeOptions = useMemo(
    () => mergeCandidates.map((candidate) => ({
      value: candidate.projectId,
      label: `${candidate.code} · ${candidate.name}`,
    })),
    [mergeCandidates],
  );

  if (!isValidProjectId) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" message="Некорректный идентификатор проекта" showIcon />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Title level={3} style={{ margin: 0 }}>
          Проект
        </Title>

        <Card
          loading={loading}
          title={project ? `${project.code} · ${project.name}` : 'Карточка проекта'}
          extra={(
            <Space>
              <Button onClick={() => setMergeModalOpen(true)} disabled={project === null}>
                Объединить с…
              </Button>
              <Button type="primary" onClick={() => void handleSave()} loading={saving} disabled={project === null}>
                Сохранить
              </Button>
            </Space>
          )}
        >
          {project === null && !loading ? (
            <Alert type="warning" message="Проект не найден" showIcon />
          ) : (
            <Form form={form} layout="vertical">
              <Form.Item
                label="Код"
                name="code"
                rules={[{ required: true, message: 'Укажите код проекта' }]}
              >
                <Input maxLength={50} />
              </Form.Item>
              <Form.Item
                label="Имя"
                name="name"
                rules={[{ required: true, message: 'Укажите имя проекта' }]}
              >
                <Input maxLength={255} />
              </Form.Item>
              <Form.Item label="Клиент">
                <Input value={project?.clientName?.trim() || (project ? `Клиент #${project.clientId}` : '')} readOnly />
              </Form.Item>
              <Form.Item label="Заметки" name="notes">
                <Input.TextArea rows={4} />
              </Form.Item>
            </Form>
          )}
        </Card>

        <Card title="Заказы проекта">
          <Table<ProjectOrderSummary>
            rowKey="orderId"
            columns={orderColumns}
            dataSource={project?.orders ?? []}
            loading={loading}
            pagination={false}
            rowClassName={(row) => orderDeletedReferenceClassName(row.deleteFlag)}
          />
        </Card>
      </Space>

      <Modal
        title="Объединить с…"
        open={mergeModalOpen}
        onCancel={() => {
          setMergeModalOpen(false);
          setSelectedSourceProjectId(undefined);
        }}
        onOk={() => void handleMerge()}
        okText="Объединить"
        cancelText="Отмена"
        confirmLoading={mergeSubmitting}
        okButtonProps={{ disabled: selectedSourceProjectId === undefined }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>Выберите проект-источник того же клиента.</div>
          <Select
            value={selectedSourceProjectId}
            onChange={(value) => setSelectedSourceProjectId(value)}
            options={mergeOptions}
            loading={mergeCandidatesLoading}
            placeholder="Проект для объединения"
            allowClear
            showSearch
            filterOption={(input, option) =>
              typeof option?.label === 'string' &&
              option.label.toLowerCase().includes(input.toLowerCase())
            }
            style={{ width: '100%' }}
          />
        </Space>
      </Modal>
    </div>
  );
};

function formatAmount(value: string | null): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? formatNumber(amount, 2) : '—';
}

function normalizeOptionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function showProjectMutationError(error: unknown, fallbackMessage: string): void {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'VERSION_CONFLICT' || error.code === 'PROJECT_CODE_TAKEN' || error.code === 'CODE_TAKEN')
  ) {
    notification.error({
      message: fallbackMessage,
      description: error.message,
      duration: 0,
    });
    return;
  }

  message.error(error instanceof Error ? error.message : fallbackMessage);
}
