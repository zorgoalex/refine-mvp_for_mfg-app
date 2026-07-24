import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../../../api/labelsApi';
import type { LabelCutMapOption, LabelTemplate, OrderLabelCutMapOptions, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';
import { OrderLabelPagesViewer } from './OrderLabelPagesViewer';
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
}> = ({ preview }) => (
  <OrderLabelPagesViewer
    svgPages={preview.svgPages}
    title={`Предпросмотр бирок: ${preview.labelCount} шт.`}
    printEnabled={false}
  />
);

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
  const [generatedPreview, setGeneratedPreview] = useState<OrderLabelsPreview | null>(null);
  const [generatedGenerationId, setGeneratedGenerationId] = useState<number | null>(null);
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
  const hasCutMap = Boolean(selectedTemplate?.elements.some((element) => element.kind === 'cut_map'));
  const cutMapRows = useMemo(() => buildOrderCutMapLabelRows(cutMapOptions), [cutMapOptions]);
  const staleCutMapRowKeys = useMemo(() => {
    const staleCandidates = new Set<string>();
    for (const detail of cutMapOptions?.details ?? []) {
      for (const option of detail.options) {
        if (!option.dimensionsMatch) staleCandidates.add(`${detail.detailId}:${option.instance}`);
      }
    }
    return new Set(
      cutMapRows
        .filter((row) => row.options.length === 0 && staleCandidates.has(row.key))
        .map((row) => row.key),
    );
  }, [cutMapOptions, cutMapRows]);
  const selectableCutMapRows = useMemo(
    () => cutMapRows.filter((row) => row.options.length > 0 || staleCutMapRowKeys.has(row.key)),
    [cutMapRows, staleCutMapRowKeys],
  );
  const labelsWithoutCutMap = cutMapRows.filter(
    (row) => row.options.length === 0 && !staleCutMapRowKeys.has(row.key),
  ).length;
  const staleCutMapCount = cutMapRows.filter((row) => staleCutMapRowKeys.has(row.key)).length;
  const previewCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(cutMapRows, cutMapSelection, previewDetailId) : undefined,
    [cutMapRows, cutMapSelection, hasCutMap, previewDetailId],
  );
  const generationCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(cutMapRows, cutMapSelection) : undefined,
    [cutMapRows, cutMapSelection, hasCutMap],
  );
  const missingPreviewCutMaps = useMemo(
    () => hasCutMap ? missingOrderCutMapRows(selectableCutMapRows, cutMapSelection, previewDetailId) : [],
    [cutMapSelection, hasCutMap, previewDetailId, selectableCutMapRows],
  );
  const missingGenerationCutMaps = useMemo(
    () => hasCutMap ? missingOrderCutMapRows(selectableCutMapRows, cutMapSelection) : [],
    [cutMapSelection, hasCutMap, selectableCutMapRows],
  );
  const detailFilters = useMemo(
    () => previewDetailId ? { detailIds: [previewDetailId] } : undefined,
    [previewDetailId],
  );

  useEffect(() => {
    if (!open) return;
    setPreviewDetailId(initialDetailId);
    setPreview(null);
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
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
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
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

  useEffect(() => {
    if (!open) return;
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
  }, [cutMapSelection, open, templateId, useBasisFields]);

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
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
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
  }, [cutMapOptionsLoading, generating, open, previewDetailId, runPreview, selectedTemplate, isOrderDirty, useBasisFields]);

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || isOrderDirty || cutMapOptionsLoading || missingGenerationCutMaps.length > 0) return;
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
      setGeneratedPreview(generationPreview);
      setGeneratedGenerationId(generation.generationId);
      setPreview(generationPreview);
      onGenerated?.();
      message.success('Бирки сформированы: список доступен для просмотра и печати');
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
            Сформировать и скачать ZIP
          </Button>,
        ]}
        width={1080}
        destroyOnClose
      >
        <style>{`
          .order-label-generate-layout {
            /* Keep position selection and label preview side by side at every viewport width. */
            display: grid;
            grid-template-columns: minmax(380px, 1fr) minmax(360px, 0.9fr);
            gap: 20px;
            align-items: start;
            overflow-x: auto;
            padding-bottom: 4px;
          }
          .order-label-generate-controls,
          .order-label-generate-preview-panel {
            min-width: 0;
          }
          .order-label-generate-preview-panel {
            position: sticky;
            top: 0;
            padding: 16px;
            border-radius: 12px;
            background: var(--app-surface, #fff);
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1), 0 8px 24px rgba(0, 0, 0, 0.06);
          }
          .order-label-generate-preview-empty {
            display: grid;
            min-height: 240px;
            place-items: center;
            padding: 24px;
            text-align: center;
          }
          .order-label-cut-map-list {
            max-height: 360px;
            overflow-y: auto;
            padding-right: 4px;
          }
          .order-label-cut-map-row {
            display: grid;
            grid-template-columns: minmax(140px, 0.75fr) minmax(200px, 1.25fr);
            gap: 8px;
            align-items: center;
          }
          @media (max-width: 680px) {
            .order-label-cut-map-row {
              grid-template-columns: minmax(0, 1fr);
            }
          }
        `}</style>
        <div className="order-label-generate-layout">
          <div className="order-label-generate-controls">
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
                    Выберите раскрой для участвовавших в нём экземпляров. Остальные бирки будут сформированы без миниатюры.
                  </Text>
                  {!canViewCut && <Alert type="error" showIcon message="Нет права на просмотр раскроев" />}
                  {cutMapOptionsLoading && <Text type="secondary">Загрузка раскроев...</Text>}
                  {!cutMapOptionsLoading && labelsWithoutCutMap > 0 && (
                    <Alert
                      type="info"
                      showIcon
                      message={`${labelsWithoutCutMap} бирок будут без миниатюры раскроя`}
                    />
                  )}
                  {!cutMapOptionsLoading && staleCutMapCount > 0 && (
                    <Alert
                      type="error"
                      showIcon
                      message={`${staleCutMapCount} деталей изменились после раскроя`}
                      description="Выполните новый раскрой этих деталей перед формированием бирок с миниатюрой."
                    />
                  )}
                  {!cutMapOptionsLoading && missingGenerationCutMaps.length > 0 && (
                    <Alert
                      type="warning"
                      showIcon
                      message={`Не выбран или устарел раскрой для ${missingGenerationCutMaps.length} бирок`}
                      description="Выберите доступный результат. Только детали, которые не участвовали в раскрое, не блокируют формирование."
                    />
                  )}
                  {!cutMapOptionsLoading && cutMapRows.length > 0 && (
                    <div className="order-label-cut-map-list">
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        {cutMapRows.map((row) => {
                          const hasOptions = row.options.length > 0;
                          const hasStaleCutMap = staleCutMapRowKeys.has(row.key);
                          const hasValidSelection = row.options.some(
                            (option) => option.cutResultPlacementId === cutMapSelection[row.key],
                          );
                          return (
                            <div key={row.key} className="order-label-cut-map-row">
                              <Text ellipsis={{ tooltip: row.label }}>{row.label}</Text>
                              <Select
                                style={{ width: '100%' }}
                                value={cutMapSelection[row.key]}
                                disabled={!hasOptions}
                                status={(hasOptions && !hasValidSelection) || hasStaleCutMap ? 'warning' : undefined}
                                placeholder={hasOptions
                                  ? 'Выберите раскрой'
                                  : hasStaleCutMap
                                    ? 'Деталь изменена — выполните новый раскрой'
                                    : 'Нет раскроя — бирка будет без миниатюры'}
                                onChange={(cutResultPlacementId) => {
                                  setCutMapSelection((current) => ({ ...current, [row.key]: cutResultPlacementId }));
                                }}
                                options={row.options.map((option) => ({
                                  value: option.cutResultPlacementId,
                                  label: cutMapOptionLabel(option),
                                }))}
                              />
                            </div>
                          );
                        })}
                      </Space>
                    </div>
                  )}
                </Space>
              )}
            </Space>
          </div>
          <div className="order-label-generate-preview-panel">
            {generatedPreview ? (
              <OrderLabelPagesViewer
                svgPages={generatedPreview.svgPages}
                title={`Сформированные бирки${generatedGenerationId ? ` #${generatedGenerationId}` : ''}: ${generatedPreview.labelCount} шт.`}
                printTitle={`Заказ ${orderId} — бирки${generatedGenerationId ? ` #${generatedGenerationId}` : ''}`}
              />
            ) : preview && selectedTemplate ? (
              <OrderLabelGeneratePreviewSurface preview={preview} template={selectedTemplate} />
            ) : (
              <div className="order-label-generate-preview-empty">
                <Text type="secondary">Выберите шаблон и позицию, чтобы увидеть бирки.</Text>
              </div>
            )}
          </div>
        </div>
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
