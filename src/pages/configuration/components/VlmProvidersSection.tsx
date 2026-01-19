/**
 * VlmProvidersSection - CRUD для провайдеров VLM
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
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  StarOutlined,
  StarFilled,
} from '@ant-design/icons';
import { useList, useCreate, useUpdate, useDelete } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';

// Types
export interface VlmProvider {
  provider_id: number;
  name: string;
  notes?: string;
  is_default: boolean;
  priority: number;
  is_active: boolean;
  sort_order: number;
}

interface ProviderFormValues {
  name: string;
  notes?: string;
  is_default: boolean;
  priority: number;
  is_active: boolean;
  sort_order: number;
}

export const VlmProvidersSection: React.FC = () => {
  const [form] = Form.useForm<ProviderFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<VlmProvider | null>(null);

  // Load providers
  const { data: providersData, isLoading, refetch } = useList<VlmProvider>({
    resource: 'vlm_providers',
    pagination: { pageSize: 100 },
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  const providers = useMemo(() => providersData?.data || [], [providersData]);

  // Mutations
  const { mutate: createProvider, isLoading: isCreating } = useCreate();
  const { mutate: updateProvider, isLoading: isUpdating } = useUpdate();
  const { mutate: deleteProvider } = useDelete();

  // Open modal for create
  const handleCreate = () => {
    setEditingProvider(null);
    form.resetFields();
    form.setFieldsValue({
      is_default: false,
      is_active: true,
      priority: 0,
      sort_order: (providers.length + 1) * 10,
    });
    setModalOpen(true);
  };

  // Open modal for edit
  const handleEdit = (provider: VlmProvider) => {
    setEditingProvider(provider);
    form.setFieldsValue({
      name: provider.name,
      notes: provider.notes || '',
      is_default: provider.is_default,
      priority: provider.priority,
      is_active: provider.is_active,
      sort_order: provider.sort_order,
    });
    setModalOpen(true);
  };

  // Delete provider
  const handleDelete = (provider: VlmProvider) => {
    deleteProvider(
      {
        resource: 'vlm_providers',
        id: provider.provider_id,
        meta: { idColumnName: 'provider_id' },
      },
      {
        onSuccess: () => {
          message.success(`Провайдер "${provider.name}" удалён`);
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

      if (editingProvider) {
        // Update
        updateProvider(
          {
            resource: 'vlm_providers',
            id: editingProvider.provider_id,
            values,
            meta: { idColumnName: 'provider_id' },
          },
          {
            onSuccess: () => {
              message.success('Провайдер обновлён');
              setModalOpen(false);
              refetch();
            },
            onError: (error: any) => {
              message.error(error?.message || 'Ошибка обновления');
            },
          }
        );
      } else {
        // Create
        createProvider(
          {
            resource: 'vlm_providers',
            values,
          },
          {
            onSuccess: () => {
              message.success('Провайдер создан');
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
      title: 'Порядок',
      dataIndex: 'sort_order',
      key: 'sort_order',
      width: 80,
      align: 'center' as const,
    },
    {
      title: 'Название',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: VlmProvider) => (
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
      title: 'Приоритет',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      align: 'center' as const,
    },
    {
      title: 'Статус',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'green' : 'default'}>
          {isActive ? 'Активен' : 'Неактивен'}
        </Tag>
      ),
    },
    {
      title: 'Примечание',
      dataIndex: 'notes',
      key: 'notes',
      ellipsis: true,
      render: (notes: string) => notes || <span style={{ color: '#999' }}>—</span>,
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 100,
      render: (_: any, record: VlmProvider) => (
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
            title="Удалить провайдера?"
            description={`"${record.name}" будет удалён вместе со всеми моделями`}
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
            <ApiOutlined />
            <span>Провайдеры VLM</span>
            <Tag>{providers.length}</Tag>
          </Space>
        }
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleCreate}
          >
            Добавить
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Table
          dataSource={providers}
          columns={columns}
          rowKey="provider_id"
          size="small"
          loading={isLoading}
          pagination={false}
        />
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        title={editingProvider ? 'Редактировать провайдера' : 'Новый провайдер'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={isCreating || isUpdating}
        width={500}
        okText={editingProvider ? 'Сохранить' : 'Создать'}
        cancelText="Отмена"
        modalRender={(modal) => (
          <DraggableModalWrapper open={modalOpen}>{modal}</DraggableModalWrapper>
        )}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Введите название' }]}
          >
            <Input placeholder="zai, openrouter, bigmodel..." />
          </Form.Item>

          <Form.Item name="notes" label="Примечание">
            <Input.TextArea rows={2} placeholder="Описание провайдера" />
          </Form.Item>

          <Space style={{ width: '100%' }} size="large">
            <Form.Item name="sort_order" label="Порядок сортировки">
              <InputNumber min={0} style={{ width: 100 }} />
            </Form.Item>

            <Form.Item name="priority" label="Приоритет (fallback)">
              <InputNumber min={0} style={{ width: 100 }} />
            </Form.Item>
          </Space>

          <Space size="large">
            <Form.Item name="is_active" label="Активен" valuePropName="checked">
              <Switch />
            </Form.Item>

            <Form.Item name="is_default" label="По умолчанию" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
};

export default VlmProvidersSection;
