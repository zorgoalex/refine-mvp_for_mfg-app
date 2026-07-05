import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Empty, Space, Table, Tag, message } from 'antd';
import { EditOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { ApiError } from '../../../api/apiError';
import { labelsApi } from '../../../api/labelsApi';
import type { LabelOcrTemplate } from '../../../api/types/labelsApi.types';
import { summarizeFieldTags } from './ocrTemplateHelpers';

interface OcrTemplatesConfigProps {
  canManage: boolean;
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `ocr-template-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function reportError(error: unknown, fallback: string): void {
  if (error instanceof ApiError) {
    message.error(error.message || fallback);
    return;
  }
  message.error(fallback);
}

/**
 * List view for configurable OCR label templates. Self-contained (own load/loading/error
 * state) so the host LabelsConfigTab only needs a single additive mount point.
 *
 * The editor is a stub for now: it opens a Drawer placeholder that Task 9 will replace
 * with the real OcrTemplateEditor (rule builder + preview/test against a sample photo).
 */
export const OcrTemplatesConfig: React.FC<OcrTemplatesConfigProps> = ({ canManage }) => {
  const [templates, setTemplates] = useState<LabelOcrTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTemplate, setEditorTemplate] = useState<LabelOcrTemplate | undefined>(undefined);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const list = await labelsApi.listOcrTemplates(true);
      setTemplates(list);
    } catch (error) {
      reportError(error, 'Не удалось загрузить OCR-шаблоны');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const handleOpenEditor = useCallback((template?: LabelOcrTemplate) => {
    setEditorTemplate(template);
    setEditorOpen(true);
  }, []);

  const handleDeactivate = useCallback(
    async (template: LabelOcrTemplate) => {
      try {
        await labelsApi.deleteOcrTemplate(template.labelOcrTemplateId, template.version, newIdempotencyKey());
        message.success('OCR-шаблон деактивирован');
        await loadTemplates();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          message.error('OCR-шаблон изменён в другом месте. Список обновлён.');
          void loadTemplates();
          return;
        }
        reportError(error, 'Не удалось деактивировать OCR-шаблон');
      }
    },
    [loadTemplates],
  );

  const columns = [
    { title: 'Название', dataIndex: 'name', key: 'name' },
    {
      title: 'Активность',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 120,
      render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Активен' : 'Отключен'}</Tag>,
    },
    {
      title: 'Поля',
      key: 'fields',
      render: (_: unknown, template: LabelOcrTemplate) => (
        <Space size={[4, 4]} wrap>
          {summarizeFieldTags(template.rules).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </Space>
      ),
    },
    // LabelOcrTemplate has no updatedAt timestamp yet — version is the closest
    // change-indicator available from the backend DTO.
    { title: 'Версия', dataIndex: 'version', key: 'version', width: 90 },
    {
      title: '',
      key: 'actions',
      width: 220,
      render: (_: unknown, template: LabelOcrTemplate) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} disabled={!canManage} onClick={() => handleOpenEditor(template)}>
            Редактировать
          </Button>
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            disabled={!canManage || !template.isActive}
            onClick={() => void handleDeactivate(template)}
          >
            Деактивировать
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} disabled={!canManage} onClick={() => handleOpenEditor(undefined)}>
            Создать
          </Button>
        </div>
        <Table<LabelOcrTemplate>
          rowKey="labelOcrTemplateId"
          size="small"
          loading={loading}
          dataSource={templates}
          columns={columns}
          pagination={false}
          locale={{ emptyText: <Empty description="Нет OCR-шаблонов" /> }}
        />
      </Space>

      {/* Placeholder editor slot — Task 9 replaces this Drawer body with the real
          OcrTemplateEditor (rule builder + preview/test against a sample photo). */}
      <Drawer
        title={editorTemplate ? `OCR-шаблон: ${editorTemplate.name}` : 'Новый OCR-шаблон'}
        width={520}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
      >
        <Empty description="Редактор OCR-шаблонов появится в следующем этапе" />
      </Drawer>
    </div>
  );
};

export default OcrTemplatesConfig;
