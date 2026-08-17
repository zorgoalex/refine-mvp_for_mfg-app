import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Radio, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { authSession } from '../../../../api/authSession';
import { labelsApi } from '../../../../api/labelsApi';
import { subscribeLabelTemplateChanged } from '../../../../api/labelTemplateEvents';
import type { LabelCutMapOption, LabelTemplate, OrderLabelCutMapOptions, OrderLabelsPreview } from '../../../../api/types/labelsApi.types';
import { can } from '../../../../utils/permissions';
import { saveLabelBlob } from './labelDownloads';
import { OrderLabelPagesViewer } from './OrderLabelPagesViewer';
import {
  buildOrderCutMapLabelRows,
  buildOrderCutMapSelectionForSource,
  buildOrderCutMapSelections,
  filterOrderCutMapRowsForSource,
  missingOrderCutMapRows,
  orderCutMapRawOptionMatchesSource,
  orderCutMapSourceCutNumbers,
  pickDefaultOrderCutMapSource,
  type OrderCutMapSelectionState,
  type OrderCutMapSelectionSource,
} from './orderCutMapSelection';
import {
  loadAppendBlankLabelOnPrintPreference,
  resolvePreferredLabelTemplateId,
  saveAppendBlankLabelOnPrintPreference,
  saveLabelTemplatePreference,
} from './labelTemplatePreference';

const { Text } = Typography;

interface LabelPreviewDetailOption {
  detailId: number;
  label: string;
}

interface OrderLabelGenerateActionProps {
  orderId: number;
  isOrderDirty?: boolean;
  compact?: boolean;
  buttonLabel?: React.ReactNode;
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
    rows={preview.rows}
    title={`Предпросмотр бирок: ${preview.labelCount} шт.`}
    printEnabled={false}
  />
);

export const OrderLabelGenerateAction: React.FC<OrderLabelGenerateActionProps> = ({
  orderId,
  isOrderDirty = false,
  compact = false,
  buttonLabel = 'Сформировать бирки',
  onGenerated,
  initialDetailId = null,
  detailOptions = [],
}) => {
  const canGenerate = can('labels.generate');
  const canViewCut = can('cut.view');
  const labelTemplatePreferenceUserId = authSession.getUser()?.id ?? 'anon';
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [previewDetailId, setPreviewDetailId] = useState<number | null>(initialDetailId);
  const [useBasisFields, setUseBasisFields] = useState(true);
  const [appendBlankLabelOnPrint, setAppendBlankLabelOnPrint] = useState(false);
  const [preview, setPreview] = useState<OrderLabelsPreview | null>(null);
  const [generatedPreview, setGeneratedPreview] = useState<OrderLabelsPreview | null>(null);
  const [generatedGenerationId, setGeneratedGenerationId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cutMapOptions, setCutMapOptions] = useState<OrderLabelCutMapOptions | null>(null);
  const [cutMapOptionsLoading, setCutMapOptionsLoading] = useState(false);
  const [cutMapSource, setCutMapSource] = useState<OrderCutMapSelectionSource>('regular');
  const [cutMapSelection, setCutMapSelection] = useState<OrderCutMapSelectionState>({});
  const templateRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );
  const hasCutMap = Boolean(selectedTemplate?.elements.some((element) => element.kind === 'cut_map'));
  const cutMapRows = useMemo(() => buildOrderCutMapLabelRows(cutMapOptions), [cutMapOptions]);
  const sourceCutMapRows = useMemo(
    () => filterOrderCutMapRowsForSource(cutMapRows, cutMapSource),
    [cutMapRows, cutMapSource],
  );
  const cutMapSourceOptions = useMemo(() => {
    const regularNumbers = orderCutMapSourceCutNumbers(cutMapRows, 'regular');
    const bathNumbers = orderCutMapSourceCutNumbers(cutMapRows, 'bath');
    return [
      {
        value: 'regular' as const,
        label: sourceLabel('Раскрой', regularNumbers),
        disabled: regularNumbers.length === 0,
      },
      {
        value: 'bath' as const,
        label: sourceLabel('Расчет ванны', bathNumbers),
        disabled: bathNumbers.length === 0,
      },
    ];
  }, [cutMapRows]);
  const staleCutMapRowKeys = useMemo(() => {
    const staleCandidates = new Set<string>();
    for (const detail of cutMapOptions?.details ?? []) {
      for (const option of detail.options) {
        if (
          !option.dimensionsMatch
          && !option.isArchived
          && orderCutMapRawOptionMatchesSource(detail, option, cutMapSource)
        ) {
          staleCandidates.add(`${detail.detailId}:${option.instance}`);
        }
      }
    }
    return new Set(
      sourceCutMapRows
        .filter((row) => row.options.length === 0 && staleCandidates.has(row.key))
        .map((row) => row.key),
    );
  }, [cutMapOptions, cutMapSource, sourceCutMapRows]);
  const selectableCutMapRows = useMemo(
    () => sourceCutMapRows.filter((row) => row.options.length > 0 || staleCutMapRowKeys.has(row.key)),
    [sourceCutMapRows, staleCutMapRowKeys],
  );
  const labelsWithoutCutMap = sourceCutMapRows.filter(
    (row) => row.options.length === 0 && row.telegramFallback === null && !staleCutMapRowKeys.has(row.key),
  ).length;
  const staleCutMapCount = sourceCutMapRows.filter((row) => staleCutMapRowKeys.has(row.key)).length;
  const previewCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(sourceCutMapRows, cutMapSelection, previewDetailId) : undefined,
    [sourceCutMapRows, cutMapSelection, hasCutMap, previewDetailId],
  );
  const generationCutMapSelections = useMemo(
    () => hasCutMap ? buildOrderCutMapSelections(sourceCutMapRows, cutMapSelection) : undefined,
    [sourceCutMapRows, cutMapSelection, hasCutMap],
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

  const loadTemplates = useCallback(async () => {
    const requestId = templateRequestRef.current + 1;
    templateRequestRef.current = requestId;
    setLoading(true);
    try {
      const next = await labelsApi.listTemplates();
      if (templateRequestRef.current !== requestId) return;
      const activeTemplates = next.filter((template) => template.isActive);
      setTemplates((current) => {
        const currentById = new Map(current.map((template) => [template.labelTemplateId, template]));
        return activeTemplates.map((template) => {
          const previous = currentById.get(template.labelTemplateId);
          return previous?.version === template.version ? previous : template;
        });
      });
      setTemplateId((current) => (
        current && activeTemplates.some((template) => template.labelTemplateId === current)
          ? current
          : resolvePreferredLabelTemplateId(labelTemplatePreferenceUserId, activeTemplates)
      ));
    } catch {
      if (templateRequestRef.current === requestId) {
        message.error('Не удалось загрузить шаблоны бирок');
      }
    } finally {
      if (templateRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [labelTemplatePreferenceUserId]);

  useEffect(() => {
    if (!open) return;
    setPreviewDetailId(initialDetailId);
    setPreview(null);
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
    setAppendBlankLabelOnPrint(loadAppendBlankLabelOnPrintPreference(labelTemplatePreferenceUserId));
    void loadTemplates();
  }, [initialDetailId, labelTemplatePreferenceUserId, loadTemplates, open]);

  useEffect(() => {
    if (!open) return;
    const reload = (changedTemplateId?: number) => {
      if (changedTemplateId === templateId) {
        // An old in-flight preview must not win after the saved template changed.
        previewRequestRef.current += 1;
        setPreview(null);
        setGeneratedPreview(null);
        setGeneratedGenerationId(null);
      }
      void loadTemplates();
    };
    const unsubscribe = subscribeLabelTemplateChanged((payload) => reload(payload.templateId));
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [loadTemplates, open, templateId]);

  useEffect(() => {
    if (!open || !hasCutMap || !canViewCut) {
      setCutMapOptions(null);
      setCutMapSource('regular');
      setCutMapSelection({});
      setCutMapOptionsLoading(false);
      return;
    }
    let active = true;
    setPreview(null);
    setGeneratedPreview(null);
    setGeneratedGenerationId(null);
    setCutMapOptions(null);
    setCutMapSource('regular');
    setCutMapSelection({});
    setCutMapOptionsLoading(true);
    labelsApi.listOrderCutMapOptions(orderId, 'v1')
      .then((next) => {
        if (!active) return;
        const rows = buildOrderCutMapLabelRows(next);
        const source = pickDefaultOrderCutMapSource(rows);
        setCutMapOptions(next);
        setCutMapSource(source);
        setCutMapSelection(buildOrderCutMapSelectionForSource(rows, source));
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
  }, [cutMapSelection, cutMapSource, open, templateId, useBasisFields]);

  const handleCutMapSourceChange = useCallback((source: OrderCutMapSelectionSource) => {
    setCutMapSource(source);
    setCutMapSelection(buildOrderCutMapSelectionForSource(cutMapRows, source));
  }, [cutMapRows]);

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
        cutMapSource: hasCutMap ? cutMapSource : undefined,
        cutMapSelections: previewCutMapSelections,
        telegramCutMapFallbackVersion: hasCutMap ? 'v1' : undefined,
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
  }, [cutMapOptions, cutMapOptionsLoading, cutMapSource, detailFilters, hasCutMap, isOrderDirty, missingPreviewCutMaps.length, orderId, previewCutMapSelections, selectedTemplate, useBasisFields]);

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
        cutMapSource: hasCutMap ? cutMapSource : undefined,
        cutMapSelections: generationCutMapSelections,
        telegramCutMapFallbackVersion: hasCutMap ? 'v1' : undefined,
      });
      const generation = await labelsApi.generateOrderLabels(orderId, {
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        previewToken: generationPreview.previewToken,
        exportFormats: selectedTemplate.defaultExportFormats,
        useBasisFields,
        cutMapSource: hasCutMap ? cutMapSource : undefined,
        cutMapSelections: generationCutMapSelections,
        telegramCutMapFallbackVersion: hasCutMap ? 'v1' : undefined,
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
        {buttonLabel}
      </Button>
      <Modal
        title="Сформировать бирки"
        open={open}
        onCancel={() => !generating && setOpen(false)}
        footer={[
          <Button key="preview" onClick={runPreview} loading={loading || cutMapOptionsLoading} disabled={!selectedTemplate || isOrderDirty || generating || missingPreviewCutMaps.length > 0}>
            Обновить предпросмотр
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
                  saveLabelTemplatePreference(labelTemplatePreferenceUserId, value);
                }}
                options={templates.map((template) => ({
                  value: template.labelTemplateId,
                  label: template.name,
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
              <Checkbox
                checked={appendBlankLabelOnPrint}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setAppendBlankLabelOnPrint(checked);
                  saveAppendBlankLabelOnPrintPreference(labelTemplatePreferenceUserId, checked);
                }}
              >
                Добавлять в конец пустую бирку
              </Checkbox>
              {hasCutMap && (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text strong>Раскрой для миниатюры</Text>
                  <Radio.Group
                    value={cutMapSource}
                    optionType="button"
                    buttonStyle="solid"
                    options={cutMapSourceOptions}
                    onChange={(event) => handleCutMapSourceChange(event.target.value)}
                  />
                  <Text type="secondary">
                    Выберите поле детали для всего списка. Бирки без карты выбранного поля будут сформированы без миниатюры.
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
                  {!cutMapOptionsLoading && sourceCutMapRows.length > 0 && (
                    <div className="order-label-cut-map-list">
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        {sourceCutMapRows.map((row) => {
                          const hasOptions = row.options.length > 0;
                          const telegramLabel = row.telegramFallback === 'svg'
                            ? 'SVG Telegram · деталь подсвечена'
                            : row.telegramFallback === 'image'
                              ? 'Скрин Telegram · без подсветки детали'
                              : null;
                          const telegramUnavailableLabel = row.telegramUnavailableReason === 'request_limit_exceeded'
                            ? 'Скрин Telegram недоступен: превышен лимит изображений'
                            : row.telegramUnavailableReason === 'ambiguous_evidence'
                              ? 'Скрин Telegram недоступен: неоднозначное соответствие детали'
                              : row.telegramUnavailableReason === 'invalid_media'
                                ? 'Скрин Telegram недоступен: повреждённый файл'
                                : null;
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
                                  : telegramLabel
                                    ? telegramLabel
                                  : telegramUnavailableLabel
                                    ? telegramUnavailableLabel
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
                rows={generatedPreview.rows}
                title={`Сформированные бирки${generatedGenerationId ? ` #${generatedGenerationId}` : ''}: ${generatedPreview.labelCount} шт.`}
                printTitle={`Заказ ${orderId} — бирки${generatedGenerationId ? ` #${generatedGenerationId}` : ''}`}
                appendBlankLabelOnPrint={appendBlankLabelOnPrint}
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

function sourceLabel(title: string, cutNumbers: string[]): string {
  if (cutNumbers.length === 0) return title;
  if (cutNumbers.length === 1) return `${title}: ${cutNumbers[0]}`;
  return `${title}: несколько версий`;
}
