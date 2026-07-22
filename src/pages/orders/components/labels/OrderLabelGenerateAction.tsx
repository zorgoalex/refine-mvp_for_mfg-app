import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelCutMapOption, LabelTemplate, OrderLabelCutMapOptions, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';
import {
  buildDefaultOrderCutMapSelection,
  buildOrderCutMapLabelRows,
  buildOrderCutMapSelections,
  missingOrderCutMapRows,
  type OrderCutMapSelectionState,
} from './orderCutMapSelection';

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
  const canViewCut = can('cut.view');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [previewDetailId, setPreviewDetailId] = useState<number | null>(initialDetailId);
  const [useBasisFields, setUseBasisFields] = useState(true);
  const [preview, setPreview] = useState<OrderLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cutMapOptions, setCutMapOptions] = useState<OrderLabelCutMapOptions | null>(null);
  const [cutMapOptionsLoading, setCutMapOptionsLoading] = useState(false);
  const [cutMapSelection, setCutMapSelection] = useState<OrderCutMapSelectionState>({});
  const previewRequestRef = useRef(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );
  const previewAspectRatio = selectedTemplate
    ? selectedTemplate.canvasWidthMm / selectedTemplate.canvasHeightMm
    : 1;
  const hasCutMap = Boolean(selectedTemplate?.elements.some((element) => element.kind === 'cut_map'));
  const cutMapRows = useMemo(() => buildOrderCutMapLabelRows(cutMapOptions), [cutMapOptions]);
  const previewCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(cutMapRows, cutMapSelection, previewDetailId) : undefined,
    [cutMapRows, cutMapSelection, hasCutMap, previewDetailId],
  );
  const generationCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(cutMapRows, cutMapSelection) : undefined,
    [cutMapRows, cutMapSelection, hasCutMap],
  );
  const missingPreviewCutMaps = useMemo(
    () => hasCutMap ? missingOrderCutMapRows(cutMapRows, cutMapSelection, previewDetailId) : [],
    [cutMapRows, cutMapSelection, hasCutMap, previewDetailId],
  );
  const missingGenerationCutMaps = useMemo(
    () => hasCutMap ? missingOrderCutMapRows(cutMapRows, cutMapSelection) : [],
    [cutMapRows, cutMapSelection, hasCutMap],
  );
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

  useEffect(() => {
    if (!open || !hasCutMap || !canViewCut) {
      setCutMapOptions(null);
      setCutMapSelection({});
      setCutMapOptionsLoading(false);
      return;
    }
    let active = true;
    setPreview(null);
    setCutMapOptions(null);
    setCutMapSelection({});
    setCutMapOptionsLoading(true);
    labelsApi.listOrderCutMapOptions(orderId)
      .then((next) => {
        if (!active) return;
        const rows = buildOrderCutMapLabelRows(next);
        setCutMapOptions(next);
        setCutMapSelection(buildDefaultOrderCutMapSelection(rows));
      })
      .catch(() => {
        if (active) message.error('Не удалось загрузить раскрои для бирок');
      })
      .finally(() => {
        if (active) setCutMapOptionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canViewCut, hasCutMap, open, orderId, selectedTemplate?.labelTemplateId]);

  const runPreview = useCallback(async () => {
    if (
      !selectedTemplate
      || isOrderDirty
      || cutMapOptionsLoading
      || (hasCutMap && (cutMapOptions === null || missingPreviewCutMaps.length > 0))
    ) return;
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
        cutMapSelections: previewCutMapSelections,
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
  }, [cutMapOptions, cutMapOptionsLoading, detailFilters, hasCutMap, isOrderDirty, missingPreviewCutMaps.length, orderId, previewCutMapSelections, selectedTemplate, useBasisFields]);

  useEffect(() => {
    if (!open || !selectedTemplate || isOrderDirty || generating || cutMapOptionsLoading) return;
    void runPreview();
  }, [generating, open, previewDetailId, runPreview, selectedTemplate, isOrderDirty, useBasisFields]);

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || isOrderDirty || missingGenerationCutMaps.length > 0) return;
    setGenerating(true);
    try {
      const generationPreview = await labelsApi.previewOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        useBasisFields,
        cutMapSelections: generationCutMapSelections,
      });
      const generation = await labelsApi.generateOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        previewToken: generationPreview.previewToken,
        exportFormats: selectedTemplate.defaultExportFormats,
        useBasisFields,
        cutMapSelections: generationCutMapSelections,
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
          <Button key="preview" onClick={runPreview} loading={loading || cutMapOptionsLoading} disabled={!selectedTemplate || isOrderDirty || generating || missingPreviewCutMaps.length > 0}>
            Предпросмотр
          </Button>,
          <Button key="generate" type="primary" icon={<DownloadOutlined />} onClick={runGenerate} loading={generating} disabled={!preview || isOrderDirty || cutMapOptionsLoading || missingGenerationCutMaps.length > 0}>
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
          {hasCutMap && (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text strong>Раскрой для миниатюры</Text>
              <Text type="secondary">
                Для каждого физического экземпляра выберите результат раскроя. Лист и положение детали определяются автоматически.
              </Text>
              {!canViewCut && <Alert type="error" showIcon message="Нет права на просмотр раскроев" />}
              {cutMapOptionsLoading && <Text type="secondary">Загрузка раскроев...</Text>}
              {!cutMapOptionsLoading && missingGenerationCutMaps.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`Не выбран раскрой для ${missingGenerationCutMaps.length} бирок`}
                  description="Бирки с пустой или устаревшей картой не формируются. Рассчитайте раскрой либо выберите другой результат."
                />
              )}
              {!cutMapOptionsLoading && cutMapRows.length > 0 && (
                <div style={{ maxHeight: 260, overflowY: 'auto', paddingRight: 4 }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {cutMapRows.map((row) => (
                      <div key={row.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(300px, 1.5fr)', gap: 8, alignItems: 'center' }}>
                        <Text ellipsis={{ tooltip: row.label }}>{row.label}</Text>
                        <Select
                          style={{ width: '100%' }}
                          value={cutMapSelection[row.key]}
                          status={row.options.some((option) => option.cutResultPlacementId === cutMapSelection[row.key]) ? undefined : 'warning'}
                          placeholder="Выберите раскрой"
                          onChange={(cutResultPlacementId) => {
                            setCutMapSelection((current) => ({ ...current, [row.key]: cutResultPlacementId }));
                          }}
                          options={row.options.map((option) => ({
                            value: option.cutResultPlacementId,
                            label: cutMapOptionLabel(option),
                          }))}
                        />
                      </div>
                    ))}
                  </Space>
                </div>
              )}
            </Space>
          )}
          {preview && selectedTemplate && (
            <OrderLabelGeneratePreviewSurface preview={preview} template={selectedTemplate} />
          )}
        </Space>
      </Modal>
    </>
  );
};

function cutMapOptionLabel(option: LabelCutMapOption): string {
  const flags = [
    option.isCurrent ? 'текущий' : null,
    option.isArchived ? 'архив' : null,
    option.variant === 'manual' ? 'ручной' : 'авто',
  ].filter(Boolean).join(', ');
  return `${option.cutNumber} · ${option.cutJobName} · лист ${option.sheetNumber}${flags ? ` · ${flags}` : ''}`;
}
