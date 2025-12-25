/**
 * VlmPromptsSection - CRUD для промптов VLM
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
  FileTextOutlined,
  StarFilled,
} from '@ant-design/icons';
import { useList, useCreate, useUpdate, useDelete } from '@refinedev/core';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';

// Types
export interface VlmPrompt {
  prompt_id: number;
  namespace: string;
  is_default: boolean;
  is_active: boolean;
  name: string;
  notes?: string;
  version: number;
  lang: string;
  tags: string[];
  priority: number;
  prompt_id_deno?: string;
}

interface PromptFormValues {
  namespace: string;
  name: string;
  notes?: string;
  version: number;
  lang: string;
  tags?: string[];
  priority: number;
  is_default: boolean;
  is_active: boolean;
  prompt_id_deno?: string;
}

// Common namespaces
const COMMON_NAMESPACES = [
  'order_details',
  'order_analysis',
  'image_recognition',
  'data_extraction',
];

// Common languages
const COMMON_LANGUAGES = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
];

export const VlmPromptsSection: React.FC = () => {
  const [form] = Form.useForm<PromptFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<VlmPrompt | null>(null);

  // Load prompts
  const { data: promptsData, isLoading, refetch } = useList<VlmPrompt>({
    resource: 'vlm_prompts',
    pagination: { pageSize: 200 },
    sorters: [
      { field: 'namespace', order: 'asc' },
      { field: 'priority', order: 'desc' },
    ],
  });

  const prompts = useMemo(() => promptsData?.data || [], [promptsData]);

  // Get unique namespaces for filter
  const namespaces = useMemo(() => {
    const ns = new Set(prompts.map((p) => p.namespace));
    return Array.from(ns);
  }, [prompts]);

  // Mutations
  const { mutate: createPrompt, isLoading: isCreating } = useCreate();
  const { mutate: updatePrompt, isLoading: isUpdating } = useUpdate();
  const { mutate: deletePrompt } = useDelete();

  // Open modal for create
  const handleCreate = () => {
    setEditingPrompt(null);
    form.resetFields();
    form.setFieldsValue({
      is_default: false,
      is_active: true,
      priority: 0,
      version: 1,
      lang: 'ru',
      tags: [],
    });
    setModalOpen(true);
  };

  // Open modal for edit
  const handleEdit = (prompt: VlmPrompt) => {
    setEditingPrompt(prompt);
    form.setFieldsValue({
      namespace: prompt.namespace,
      name: prompt.name,
      notes: prompt.notes || '',
      version: prompt.version,
      lang: prompt.lang,
      tags: prompt.tags || [],
      priority: prompt.priority,
      is_default: prompt.is_default,
      is_active: prompt.is_active,
      prompt_id_deno: prompt.prompt_id_deno || '',
    });
    setModalOpen(true);
  };

  // Delete prompt
  const handleDelete = (prompt: VlmPrompt) => {
    deletePrompt(
      {
        resource: 'vlm_prompts',
        id: prompt.prompt_id,
        meta: { idColumnName: 'prompt_id' },
      },
      {
        onSuccess: () => {
          message.success(`Промпт "${prompt.name}" удалён`);
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

      // Ensure tags is array
      const payload = {
        ...values,
        tags: values.tags || [],
      };

      if (editingPrompt) {
        updatePrompt(
          {
            resource: 'vlm_prompts',
            id: editingPrompt.prompt_id,
            values: payload,
            meta: { idColumnName: 'prompt_id' },
          },
          {
            onSuccess: () => {
              message.success('Промпт обновлён');
              setModalOpen(false);
              refetch();
            },
            onError: (error: any) => {
              message.error(error?.message || 'Ошибка обновления');
            },
          }
        );
      } else {
        createPrompt(
          {
            resource: 'vlm_prompts',
            values: payload,
          },
          {
            onSuccess: () => {
              message.success('Промпт создан');
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
      title: 'Namespace',
      dataIndex: 'namespace',
      key: 'namespace',
      width: 150,
      render: (ns: string) => <Tag color="geekblue">{ns}</Tag>,
      filters: namespaces.map((ns) => ({ text: ns, value: ns })),
      onFilter: (value: any, record: VlmPrompt) => record.namespace === value,
    },
    {
      title: 'Название',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: VlmPrompt) => (
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
      title: 'Версия',
      dataIndex: 'version',
      key: 'version',
      width: 80,
      align: 'center' as const,
      render: (v: number) => <Tag>v{v}</Tag>,
    },
    {
      title: 'Язык',
      dataIndex: 'lang',
      key: 'lang',
      width: 80,
      align: 'center' as const,
      render: (lang: string) => (
        <Tag color={lang === 'ru' ? 'blue' : 'cyan'}>{lang.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Приоритет',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      align: 'center' as const,
    },
    {
      title: 'Теги',
      dataIndex: 'tags',
      key: 'tags',
      width: 150,
      render: (tags: string[]) =>
        tags && tags.length > 0 ? (
          <Space size={2} wrap>
            {tags.slice(0, 3).map((tag) => (
              <Tag key={tag} color="default" style={{ fontSize: 11 }}>
                {tag}
              </Tag>
            ))}
            {tags.length > 3 && (
              <Tooltip title={tags.slice(3).join(', ')}>
                <Tag style={{ fontSize: 11 }}>+{tags.length - 3}</Tag>
              </Tooltip>
            )}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>—</span>
        ),
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
      title: 'Действия',
      key: 'actions',
      width: 100,
      render: (_: any, record: VlmPrompt) => (
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
            title="Удалить промпт?"
            description={`"${record.name}" будет удалён`}
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
            <FileTextOutlined />
            <span>Промпты</span>
            <Tag>{prompts.length}</Tag>
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
          dataSource={prompts}
          columns={columns}
          rowKey="prompt_id"
          size="small"
          loading={isLoading}
          pagination={false}
          scroll={{ y: 400 }}
        />
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        title={editingPrompt ? 'Редактировать промпт' : 'Новый промпт'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={isCreating || isUpdating}
        width={600}
        okText={editingPrompt ? 'Сохранить' : 'Создать'}
        cancelText="Отмена"
        modalRender={(modal) => (
          <DraggableModalWrapper open={modalOpen}>{modal}</DraggableModalWrapper>
        )}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item
              name="namespace"
              label="Namespace"
              rules={[{ required: true, message: 'Введите namespace' }]}
              style={{ flex: 1 }}
            >
              <Select
                showSearch
                allowClear
                placeholder="Выберите или введите"
                options={COMMON_NAMESPACES.map((ns) => ({ value: ns, label: ns }))}
                mode="tags"
                maxCount={1}
              />
            </Form.Item>

            <Form.Item
              name="lang"
              label="Язык"
              rules={[{ required: true, message: 'Выберите язык' }]}
              style={{ width: 120 }}
            >
              <Select options={COMMON_LANGUAGES} />
            </Form.Item>
          </Space>

          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Введите название' }]}
          >
            <Input placeholder="parse_order_details_json" />
          </Form.Item>

          <Form.Item name="notes" label="Описание">
            <Input.TextArea rows={2} placeholder="Описание промпта" />
          </Form.Item>

          <Space style={{ width: '100%' }} size="large" wrap>
            <Form.Item
              name="version"
              label="Версия"
              rules={[{ required: true, message: 'Введите версию' }]}
            >
              <InputNumber min={1} style={{ width: 80 }} />
            </Form.Item>

            <Form.Item name="priority" label="Приоритет">
              <InputNumber min={0} style={{ width: 80 }} />
            </Form.Item>
          </Space>

          <Form.Item name="tags" label="Теги">
            <Select
              mode="tags"
              placeholder="Введите теги"
              tokenSeparators={[',', ' ']}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item name="prompt_id_deno" label="ID в Deno KV (опционально)">
            <Input placeholder="ID промпта в VLM API" />
          </Form.Item>

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

export default VlmPromptsSection;
