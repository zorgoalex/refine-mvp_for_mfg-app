/**
 * VlmModelsSection - CRUD для моделей провайдеров VLM
 * Отображает связь с провайдерами
 */

import React, { useState, useMemo } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Tag,
  Tooltip,
  message,
  Popconfirm,
  Select,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  RobotOutlined,
  StarFilled,
} from '@ant-design/icons';
import { useList, useCreate, useUpdate, useDelete } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';
import type { VlmProvider } from './VlmProvidersSection';

// Types
export interface VlmProviderModel {
  provider_model_id: number;
  provider_id: number;
  name: string;
  notes?: string;
  sort_order: number;
  is_default: boolean;
  priority: number;
  is_active: boolean;
  sys_prompt?: string;
  thinking: boolean;
  input_price?: number;
  output_price?: number;
  max_output: number;
  cache_read?: number;
  cache_write?: number;
  total_context: number;
  input_modalities: string[];
  output_modalities: string[];
  // Joined
  vlm_provider?: VlmProvider;
}

interface ModelFormValues {
  provider_id: number;
  name: string;
  notes?: string;
  sort_order: number;
  is_default: boolean;
  priority: number;
  is_active: boolean;
  thinking: boolean;
  input_price?: number;
  output_price?: number;
  max_output: number;
  total_context: number;
}

export const VlmModelsSection: React.FC = () => {
  const [form] = Form.useForm<ModelFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<VlmProviderModel | null>(null);

  // Load models with provider info
  const { data: modelsData, isLoading, refetch } = useList<VlmProviderModel>({
    resource: 'vlm_provider_models',
    pagination: { pageSize: 200 },
    sorters: [
      { field: 'provider_id', order: 'asc' },
      { field: 'sort_order', order: 'asc' },
    ],
    meta: {
      fields: [
        'provider_model_id',
        'provider_id',
        'name',
        'notes',
        'sort_order',
        'is_default',
        'priority',
        'is_active',
        'thinking',
        'input_price',
        'output_price',
        'max_output',
        'total_context',
        { vlm_provider: ['provider_id', 'name'] },
      ],
    },
  });

  // Load providers for select
  const { data: providersData } = useList<VlmProvider>({
    resource: 'vlm_providers',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  const models = useMemo(() => modelsData?.data || [], [modelsData]);
  const providers = useMemo(() => providersData?.data || [], [providersData]);

  // Provider lookup map
  const providerMap = useMemo(() => {
    const map: Record<number, VlmProvider> = {};
    providers.forEach((p) => {
      map[p.provider_id] = p;
    });
    return map;
  }, [providers]);

  // Mutations
  const { mutate: createModel, isLoading: isCreating } = useCreate();
  const { mutate: updateModel, isLoading: isUpdating } = useUpdate();
  const { mutate: deleteModel } = useDelete();

  // Open modal for create
  const handleCreate = () => {
    setEditingModel(null);
    form.resetFields();
    form.setFieldsValue({
      is_default: false,
      is_active: true,
      priority: 0,
      thinking: true,
      sort_order: 10,
      max_output: 4096,
      total_context: 128000,
    });
    setModalOpen(true);
  };

  // Open modal for edit
  const handleEdit = (model: VlmProviderModel) => {
    setEditingModel(model);
    form.setFieldsValue({
      provider_id: model.provider_id,
      name: model.name,
      notes: model.notes || '',
      is_default: model.is_default,
      priority: model.priority,
      is_active: model.is_active,
      sort_order: model.sort_order,
      thinking: model.thinking,
      input_price: model.input_price,
      output_price: model.output_price,
      max_output: model.max_output,
      total_context: model.total_context,
    });
    setModalOpen(true);
  };

  // Delete model
  const handleDelete = (model: VlmProviderModel) => {
    deleteModel(
      {
        resource: 'vlm_provider_models',
        id: model.provider_model_id,
        meta: { idColumnName: 'provider_model_id' },
      },
      {
        onSuccess: () => {
          message.success(`Модель "${model.name}" удалена`);
          refetch();
        },
        onError: (error: any) => {
          message.error(error?.message || 'Ошибка удаления');
        },
      }
    );
  };

  // Save form
  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      if (editingModel) {
        updateModel(
          {
            resource: 'vlm_provider_models',
            id: editingModel.provider_model_id,
            values,
            meta: { idColumnName: 'provider_model_id' },
          },
          {
            onSuccess: () => {
              message.success('Модель обновлена');
              setModalOpen(false);
              refetch();
            },
            onError: (error: any) => {
              message.error(error?.message || 'Ошибка обновления');
            },
          }
        );
      } else {
        createModel(
          {
            resource: 'vlm_provider_models',
            values,
          },
          {
            onSuccess: () => {
              message.success('Модель создана');
              setModalOpen(false);
              refetch();
            },
            onError: (error: any) => {
              message.error(error?.message || 'Ошибка создания');
            },
          }
        );
      }
    } catch (error) {
      // Validation failed
    }
  };

  // Table columns
  const columns = [
    {
      title: 'Провайдер',
      dataIndex: 'provider_id',
      key: 'provider_id',
      width: 130,
      render: (providerId: number, record: VlmProviderModel) => {
        const provider = record.vlm_provider || providerMap[providerId];
        return provider ? (
          <Tag color="blue">{provider.name}</Tag>
        ) : (
          <Tag color="default">ID: {providerId}</Tag>
        );
      },
      filters: providers.map((p) => ({ text: p.name, value: p.provider_id })),
      onFilter: (value: any, record: VlmProviderModel) => record.provider_id === value,
    },
    {
      title: 'Модель',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: VlmProviderModel) => (
        <Space>
          <span style={{ fontWeight: record.is_default ? 600 : 400 }}>{name}</span>
          {record.is_default && (
            <Tooltip title="По умолчанию">
              <StarFilled style={{ color: '#faad14' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Контекст',
      dataIndex: 'total_context',
      key: 'total_context',
      width: 100,
      align: 'right' as const,
      render: (ctx: number) => ctx ? `${(ctx / 1000).toFixed(0)}K` : '—',
    },
    {
      title: 'Макс. выход',
      dataIndex: 'max_output',
      key: 'max_output',
      width: 100,
      align: 'right' as const,
      render: (out: number) => out ? `${(out / 1000).toFixed(0)}K` : '—',
    },
    {
      title: 'Thinking',
      dataIndex: 'thinking',
      key: 'thinking',
      width: 80,
      align: 'center' as const,
      render: (thinking: boolean) => (
        <Tag color={thinking ? 'purple' : 'default'}>
          {thinking ? 'Да' : 'Нет'}
        </Tag>
      ),
    },
    {
      title: 'Статус',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'green' : 'default'}>
          {isActive ? 'Активна' : 'Неактивна'}
        </Tag>
      ),
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 100,
      render: (_: any, record: VlmProviderModel) => (
        <Space size="small">
          <Tooltip title="Редактировать">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title="Удалить модель?"
            description={`"${record.name}" будет удалена`}
            onConfirm={() => handleDelete(record)}
            okText="Удалить"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Удалить">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card
        size="small"
        title={
          <Space>
            <RobotOutlined />
            <span>Модели провайдеров</span>
            <Tag>{models.length}</Tag>
          </Space>
        }
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            disabled={providers.length === 0}
          >
            Добавить
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Table
          dataSource={models}
          columns={columns}
          rowKey="provider_model_id"
          size="small"
          loading={isLoading}
          pagination={false}
          scroll={{ y: 400 }}
        />
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        title={editingModel ? 'Редактировать модель' : 'Новая модель'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={isCreating || isUpdating}
        width={600}
        okText={editingModel ? 'Сохранить' : 'Создать'}
        cancelText="Отмена"
        modalRender={(modal) => (
          <DraggableModalWrapper open={modalOpen}>{modal}</DraggableModalWrapper>
        )}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="provider_id"
            label="Провайдер"
            rules={[{ required: true, message: 'Выберите провайдера' }]}
          >
            <Select
              placeholder="Выберите провайдера"
              options={providers.map((p) => ({
                value: p.provider_id,
                label: p.name,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="name"
            label="Название модели"
            rules={[{ required: true, message: 'Введите название' }]}
          >
            <Input placeholder="claude-3-5-sonnet, gpt-4o, glm-4v..." />
          </Form.Item>

          <Form.Item name="notes" label="Примечание">
            <Input.TextArea rows={2} placeholder="Описание модели" />
          </Form.Item>

          <Space style={{ width: '100%' }} size="large" wrap>
            <Form.Item name="total_context" label="Контекст (токены)">
              <InputNumber min={1} style={{ width: 130 }} />
            </Form.Item>

            <Form.Item name="max_output" label="Макс. выход">
              <InputNumber min={1} style={{ width: 130 }} />
            </Form.Item>

            <Form.Item name="sort_order" label="Порядок">
              <InputNumber min={0} style={{ width: 80 }} />
            </Form.Item>

            <Form.Item name="priority" label="Приоритет">
              <InputNumber min={0} style={{ width: 80 }} />
            </Form.Item>
          </Space>

          <Space style={{ width: '100%' }} size="large" wrap>
            <Form.Item name="input_price" label="Цена входа ($/1M)">
              <InputNumber min={0} step={0.01} style={{ width: 120 }} />
            </Form.Item>

            <Form.Item name="output_price" label="Цена выхода ($/1M)">
              <InputNumber min={0} step={0.01} style={{ width: 120 }} />
            </Form.Item>
          </Space>

          <Space size="large">
            <Form.Item name="is_active" label="Активна" valuePropName="checked">
              <Switch />
            </Form.Item>

            <Form.Item name="is_default" label="По умолчанию" valuePropName="checked">
              <Switch />
            </Form.Item>

            <Form.Item name="thinking" label="Thinking" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
};

export default VlmModelsSection;
