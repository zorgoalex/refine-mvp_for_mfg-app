import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelTemplate, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';

const { Text } = Typography;

interface LabelPreviewDetailOption {
  detailId: number;
  label: string;
}

interface OrderLabelGenerateActionProps {
  orderId: number;
  isOrderDirty?: boolean;
  compact?: boolean;
  onGenerated?: () => void;
  initialDetailId?: number | null;
  detailOptions?: LabelPreviewDetailOption[];
}

export const OrderLabelGeneratePreviewSurface: React.FC<{
  preview: OrderLabelsPreview;
  template: LabelTemplate;
}> = ({ preview, template }) => {
  const previewAspectRatio = template.canvasWidthMm / template.canvasHeightMm;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Text type="secondary">Бирок: {preview.labelCount}. Показана первая.</Text>
      {preview.svgPages.slice(0, 1).map((svg, index) => (
        <LabelSvgPreviewFrame
          key={index}
          svg={svg}
          className="order-label-preview-fit"
          style={{
            aspectRatio: `${template.canvasWidthMm} / ${template.canvasHeightMm}`,
            background: '#fff',
            border: '1px solid var(--app-border)',
            boxSizing: 'border-box',
            lineHeight: 0,
            overflow: 'hidden',
            width: `min(100%, calc(58vh * ${previewAspectRatio}))`,
          }}
        />
      ))}
    </Space>
  );
};

export const OrderLabelGenerateAction: React.FC<OrderLabelGenerateActionProps> = ({
  orderId,
  isOrderDirty = false,
  compact = false,
  onGenerated,
  initialDetailId = null,
  detailOptions = [],
}) => {
  const canGenerate = can('labels.generate');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [previewDetailId, setPreviewDetailId] = useState<number | null>(initialDetailId);
  const [useBasisFields, setUseBasisFields] = useState(true);
  const [preview, setPreview] = useState<OrderLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const previewRequestRef = useRef(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );
  const previewAspectRatio = selectedTemplate
    ? selectedTemplate.canvasWidthMm / selectedTemplate.canvasHeightMm
    : 1;
  const detailFilters = useMemo(
    () => previewDetailId ? { detailIds: [previewDetailId] } : undefined,
    [previewDetailId],
  );

  useEffect(() => {
    if (!open) return;
    setPreviewDetailId(initialDetailId);
    setLoading(true);
    labelsApi.listTemplates(true)
      .then((next) => {
        setTemplates(next);
        setTemplateId((current) => current ?? next.find((template) => template.isActive)?.labelTemplateId ?? null);
      })
      .catch(() => message.error('Не удалось загрузить шаблоны бирок'))
      .finally(() => setLoading(false));
  }, [initialDetailId, open]);

  const runPreview = useCallback(async () => {
    if (!selectedTemplate || isOrderDirty) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreview(null);
    setLoading(true);
    try {
      const nextPreview = await labelsApi.previewOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        detailFilters,
        useBasisFields,
      });
      if (previewRequestRef.current === requestId) {
        setPreview(nextPreview);
      }
    } catch {
      if (previewRequestRef.current === requestId) {
        message.error('Не удалось построить предпросмотр бирок');
      }
    } finally {
      if (previewRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [detailFilters, isOrderDirty, orderId, selectedTemplate, useBasisFields]);

  useEffect(() => {
    if (!open || !selectedTemplate || isOrderDirty || generating) return;
    void runPreview();
  }, [generating, open, previewDetailId, runPreview, selectedTemplate, isOrderDirty, useBasisFields]);

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || isOrderDirty) return;
    setGenerating(true);
    try {
      const generationPreview = await labelsApi.previewOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        useBasisFields,
      });
      const generation = await labelsApi.generateOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        previewToken: generationPreview.previewToken,
        exportFormats: selectedTemplate.defaultExportFormats,
        useBasisFields,
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
        width={680}
        destroyOnClose
      >
        <style>{`
          .order-label-preview-fit svg {
            display: block;
            width: 100%;
            height: 100%;
          }
        `}</style>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {isOrderDirty && <Alert type="warning" showIcon message="Сначала сохраните заказ" />}
          <Select
            style={{ width: '100%' }}
            value={templateId}
            loading={loading}
            onChange={(value) => {
              setTemplateId(value);
            }}
            options={templates.map((template) => ({
              value: template.labelTemplateId,
              label: template.isActive ? template.name : `${template.name} (архив)`,
            }))}
            placeholder="Шаблон"
          />
          {detailOptions.length > 0 && (
            <Select
              style={{ width: '100%' }}
              value={previewDetailId ?? 0}
              onChange={(value) => {
                setPreviewDetailId(value || null);
              }}
              options={[
                { value: 0, label: 'Все позиции: показать первую бирку' },
                ...detailOptions.map((detail) => ({ value: detail.detailId, label: detail.label })),
              ]}
              placeholder="Позиция для предпросмотра"
            />
          )}
          <Checkbox
            checked={useBasisFields}
            onChange={(event) => {
              setUseBasisFields(event.target.checked);
            }}
          >
            Использовать поля базис проекта
          </Checkbox>
          {preview && selectedTemplate && (
            <OrderLabelGeneratePreviewSurface preview={preview} template={selectedTemplate} />
          )}
        </Space>
      </Modal>
    </>
  );
};
