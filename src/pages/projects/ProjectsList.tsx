import { Table } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelect } from '@refinedev/antd';
import { Button, Form, Input, Modal, Select, Space, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { projectsApi } from '../../api/projectsApi';
import type { ProjectDto } from '../../api/projectsApi';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { formatProjectRow, type ProjectRow } from './projectHelpers';
import { filterOrderFinancialItems } from '../../utils/orderFinancialVisibility';
import { useOrderFinancialVisibility } from '../../hooks/useOrderFinancialVisibility';

const { Title } = Typography;

export const ProjectsList: React.FC = () => {
  const navigate = useNavigate();
  const { canViewFinancials } = useOrderFinancialVisibility();
  const { pageSize, setPageSize } = usePageSizePreference('projects:list', 10);
  const [currentPage, setCurrentPage] = useState(1);
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState<number | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm<{ clientId: number; name: string; code?: string; notes?: string }>();

  const { selectProps: clientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchInput]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await projectsApi.list({
        search: debouncedSearch || undefined,
        clientId: selectedClientId,
      });
      setRows(response.map((project: ProjectDto) => formatProjectRow(project)));
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedClientId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleCreate = useCallback(async () => {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      const created = await projectsApi.create({
        clientId: values.clientId,
        name: values.name.trim(),
        code: values.code?.trim() || undefined,
        notes: values.notes?.trim() ? values.notes.trim() : undefined,
        idempotencyKey: `project-create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      message.success(`Проект ${created.code} создан`);
      setCreateOpen(false);
      createForm.resetFields();
      navigate(`/projects/show/${created.projectId}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось создать проект');
    } finally {
      setCreating(false);
    }
  }, [createForm, navigate]);

  const columns = useMemo<ColumnsType<ProjectRow>>(
    () => filterOrderFinancialItems([
      {
        title: 'Код',
        dataIndex: 'code',
        key: 'code',
        width: 140,
      },
      {
        title: 'Имя',
        dataIndex: 'name',
        key: 'name',
      },
      {
        title: 'Клиент',
        dataIndex: 'clientLabel',
        key: 'clientLabel',
      },
      {
        title: 'Заказов',
        dataIndex: 'ordersCountLabel',
        key: 'ordersCountLabel',
        width: 120,
      },
      {
        title: 'Сумма',
        dataIndex: 'totalFinalAmountLabel',
        key: 'totalFinalAmountLabel',
        width: 150,
      },
      {
        title: 'Оплачено',
        dataIndex: 'totalPaidAmountLabel',
        key: 'totalPaidAmountLabel',
        width: 150,
      },
    ], canViewFinancials),
    [canViewFinancials],
  );

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Title level={3} style={{ margin: 0 }}>
          Проекты
        </Title>

        <Space wrap>
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Создать проект
          </Button>
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Поиск по коду или имени"
            allowClear
            style={{ width: 280 }}
          />
          <Select
            {...clientSelectProps}
            value={selectedClientId}
            onChange={(value) => setSelectedClientId(value)}
            placeholder="Клиент"
            allowClear
            showSearch
            style={{ width: 280 }}
          />
        </Space>

        <Table<ProjectRow>
          rowKey="projectId"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{
            current: currentPage,
            pageSize,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            onChange: (nextPage, nextPageSize) => {
              if (nextPageSize !== pageSize) {
                setPageSize(nextPageSize);
                setCurrentPage(1);
                return;
              }
              setCurrentPage(nextPage);
            },
          }}
          onRow={(record) => ({
            onClick: () => navigate(`/projects/show/${record.projectId}`),
            style: { cursor: 'pointer' },
          })}
        />

        <Modal
          title="Новый проект"
          open={createOpen}
          onOk={() => void handleCreate()}
          confirmLoading={creating}
          onCancel={() => setCreateOpen(false)}
          okText="Создать"
          cancelText="Отмена"
          destroyOnClose
        >
          <Form form={createForm} layout="vertical" preserve={false}>
            <Form.Item name="clientId" label="Клиент" rules={[{ required: true, message: 'Выберите клиента' }]}>
              <Select {...clientSelectProps} placeholder="Клиент" showSearch allowClear />
            </Form.Item>
            <Form.Item name="name" label="Имя проекта" rules={[{ required: true, whitespace: true, message: 'Укажите имя' }, { max: 300 }]}>
              <Input placeholder="Например: Кухня Фрунзе 26" />
            </Form.Item>
            <Form.Item
              name="code"
              label="Код (необязательно)"
              tooltip="Пусто — присвоится автоматический «МП-N»"
              rules={[{ pattern: /^[0-9A-Za-zА-Яа-яЁё-]{1,20}$/u, message: 'Буквы/цифры/дефис, до 20 символов' }]}
            >
              <Input placeholder="ФК26" maxLength={20} />
            </Form.Item>
            <Form.Item name="notes" label="Заметки" rules={[{ max: 4000 }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </div>
  );
};
