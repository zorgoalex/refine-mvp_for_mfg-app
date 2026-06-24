import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelTemplate, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';

const { Text } = Typography;

interface OrderLabelGenerateActionProps {
  orderId: number;
  isOrderDirty?: boolean;
  compact?: boolean;
  onGenerated?: () => void;
}

export const OrderLabelGenerateAction: React.FC<OrderLabelGenerateActionProps> = ({ orderId, isOrderDirty = false, compact = false, onGenerated }) => {
  const canGenerate = can('labels.generate');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [preview, setPreview] = useState<OrderLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    labelsApi.listTemplates(true)
      .then((next) => {
        setTemplates(next);
        setTemplateId((current) => current ?? next.find((template) => template.isActive)?.labelTemplateId ?? null);
      })
      .catch(() => message.error('Не удалось загрузить шаблоны бирок'))
      .finally(() => setLoading(false));
  }, [open]);

  const runPreview = async () => {
    if (!selectedTemplate || isOrderDirty) return;
    setLoading(true);
    try {
      setPreview(await labelsApi.previewOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
      }));
    } catch {
      message.error('Не удалось построить предпросмотр бирок');
    } finally {
      setLoading(false);
    }
  };

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || isOrderDirty) return;
    setGenerating(true);
    try {
      const generation = await labelsApi.generateOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        previewToken: preview.previewToken,
        exportFormats: selectedTemplate.defaultExportFormats,
        idempotencyKey: `order-labels-generate-${orderId}-${Date.now()}`,
      });
      const downloaded = await labelsApi.downloadGeneration(orderId, generation.generationId);
      saveLabelBlob(downloaded.blob, downloaded.fileName ?? `order-${orderId}-labels-${generation.generationId}.zip`);
      onGenerated?.();
      message.success('Бирки сформированы');
      setOpen(false);
    } catch {
      message.error('Не удалось сформировать бирки');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Button
        icon={<TagsOutlined />}
        size={compact ? 'small' : 'middle'}
        type={compact ? 'default' : 'primary'}
        disabled={!canGenerate || isOrderDirty}
        onClick={() => setOpen(true)}
      >
        Сформировать бирки
      </Button>
      <Modal
        title="Сформировать бирки"
        open={open}
        onCancel={() => !generating && setOpen(false)}
        footer={[
          <Button key="preview" onClick={runPreview} loading={loading} disabled={!selectedTemplate || isOrderDirty || generating}>
            Предпросмотр
          </Button>,
          <Button key="generate" type="primary" icon={<DownloadOutlined />} onClick={runGenerate} loading={generating} disabled={!preview || isOrderDirty}>
            Сформировать и скачать
          </Button>,
        ]}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {isOrderDirty && <Alert type="warning" showIcon message="Сначала сохраните заказ" />}
          <Select
            style={{ width: '100%' }}
            value={templateId}
            loading={loading}
            onChange={(value) => {
              setTemplateId(value);
              setPreview(null);
            }}
            options={templates.map((template) => ({
              value: template.labelTemplateId,
              label: template.isActive ? template.name : `${template.name} (архив)`,
            }))}
            placeholder="Шаблон"
          />
          {preview && (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary">Бирок: {preview.labelCount}</Text>
              {preview.svgPages.slice(0, 2).map((svg, index) => (
                <div
                  key={index}
                  style={{ border: '1px solid #d9d9d9', maxHeight: 220, overflow: 'auto' }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ))}
            </Space>
          )}
        </Space>
      </Modal>
    </>
  );
};
