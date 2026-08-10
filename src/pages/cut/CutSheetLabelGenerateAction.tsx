import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, PrinterOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../api/labelsApi';
import type {
  DetailLabelsPreview,
  LabelCutMapFallbackImage,
  LabelCutSheetDetailInstance,
  LabelExportFormat,
  LabelTemplate,
  PreviewDetailLabelsInput,
} from '../../api/types/labelsApi.types';
import { can } from '../../utils/permissions';
import { saveLabelBlob } from '../orders/components/labels/labelDownloads';
import { printLabelSvgPages } from '../orders/components/labels/labelPrint';

const { Text } = Typography;

/** Selectable export file formats for generated labels (checkboxes in the modal). */
const EXPORT_FORMAT_OPTIONS: { value: LabelExportFormat; label: string }[] = [
  { value: 'bmp', label: 'BMP' },
  { value: 'png', label: 'PNG' },
  { value: 'emf', label: 'EMF' },
];

interface CutSheetLabelGenerateActionProps {
  detailInstances: LabelCutSheetDetailInstance[];
  cutJobId?: number | null;
  cutGroupId?: number | null;
  sheetIndex: number;
  sheetLabel?: string;
  cutMapFallbackImage?: LabelCutMapFallbackImage | null;
}

export type CutSheetLabelDetailInstance = LabelCutSheetDetailInstance;

export const CutSheetLabelGenerateAction: React.FC<CutSheetLabelGenerateActionProps> = ({
  detailInstances,
  cutJobId,
  cutGroupId,
  sheetIndex,
  sheetLabel,
  cutMapFallbackImage,
}) => {
  const hasCutMapContext = Boolean((cutJobId && cutGroupId) || cutMapFallbackImage);
  const canGenerate = can('labels.generate') && (!hasCutMapContext || can('cut.view'));
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [useBasisFields, setUseBasisFields] = useState(true);
  const [exportFormats, setExportFormats] = useState<LabelExportFormat[]>([]);
  const [preview, setPreview] = useState<DetailLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [printing, setPrinting] = useState(false);
  const previewRequestRef = useRef(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );
  const detailIds = useMemo(() => detailInstances.map((instance) => instance.detailId), [detailInstances]);
  const cutSheetScope = useMemo(() => (
    cutJobId && cutGroupId
      ? { cutJobId, cutGroupId, sheetIndex, detailInstances }
      : undefined
  ), [cutGroupId, cutJobId, detailInstances, sheetIndex]);
  const resolvedSheetLabel = sheetLabel ?? `листа ${sheetIndex + 1}`;
  const disabled = !canGenerate || detailInstances.length === 0;

  const buildRequest = useCallback((template: LabelTemplate): PreviewDetailLabelsInput => ({
    templateId: template.labelTemplateId,
    templateVersion: template.version,
    detailIds,
    useBasisFields,
    ...(cutSheetScope ? { cutSheetScope } : { detailInstances }),
    ...(cutMapFallbackImage ? { cutMapFallbackImage } : {}),
  }), [cutMapFallbackImage, cutSheetScope, detailIds, detailInstances, useBasisFields]);

  // Seed the export-format checkboxes from the selected template's defaults
  // whenever the chosen template changes; the operator can then toggle them.
  useEffect(() => {
    if (selectedTemplate) setExportFormats(selectedTemplate.defaultExportFormats);
  }, [selectedTemplate?.labelTemplateId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    labelsApi.listTemplates(true)
      .then((next) => {
        setTemplates(next);
        setTemplateId((current) => (
          current && next.some((template) => template.labelTemplateId === current)
            ? current
            : next.find((template) => template.isActive)?.labelTemplateId ?? null
        ));
      })
      .catch(() => message.error('Не удалось загрузить шаблоны бирок'))
      .finally(() => setLoading(false));
  }, [open]);

  const runPreview = useCallback(async () => {
    if (!selectedTemplate || detailIds.length === 0) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setLoading(true);
    try {
      const nextPreview = await labelsApi.previewDetailLabels({
        ...buildRequest(selectedTemplate),
      });
      if (previewRequestRef.current === requestId) setPreview(nextPreview);
    } catch {
      if (previewRequestRef.current === requestId) message.error('Не удалось построить предпросмотр бирок');
    } finally {
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  }, [buildRequest, detailIds.length, selectedTemplate]);

  useEffect(() => {
    if (!open || !selectedTemplate || generating) return;
    void runPreview();
  }, [generating, open, runPreview, selectedTemplate, useBasisFields]);

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || exportFormats.length === 0) return;
    setGenerating(true);
    try {
      const generationPreview = await labelsApi.previewDetailLabels({
        ...buildRequest(selectedTemplate),
      });
      const generation = await labelsApi.generateDetailLabels({
        ...buildRequest(selectedTemplate),
        previewToken: generationPreview.previewToken,
        exportFormats,
        idempotencyKey: `cut-sheet-labels-${cutJobId ?? 'image'}-${cutGroupId ?? 0}-${sheetIndex}-${Date.now()}`,
      });
      const downloaded = await labelsApi.downloadDetailGeneration(generation.generationId);
      saveLabelBlob(
        downloaded.blob,
        downloaded.fileName ?? `cut-${cutJobId}-g${cutGroupId}-s${sheetIndex + 1}-labels-${generation.generationId}.zip`,
      );
      message.success('Бирки сформированы');
      setOpen(false);
    } catch {
      message.error('Не удалось сформировать бирки');
    } finally {
      setGenerating(false);
    }
  };

  const runPrint = async () => {
    if (!selectedTemplate || detailIds.length === 0) return;
    setPrinting(true);
    try {
      const printPreview = await labelsApi.previewDetailLabels({
        ...buildRequest(selectedTemplate),
      });
      setPreview(printPreview);
      const printed = printLabelSvgPages(printPreview.svgPages, `Бирки ${resolvedSheetLabel}`);
      if (!printed) message.warning('Нет бирок для печати');
    } catch {
      message.error('Не удалось открыть печать бирок');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <>
      <Button
        className="app-hit-area-sm"
        size="small"
        icon={<TagsOutlined />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Бирки
      </Button>
      <Modal
        title={`Бирки ${resolvedSheetLabel}`}
        open={open}
        onCancel={() => !generating && setOpen(false)}
        footer={[
          <Button key="preview" onClick={runPreview} loading={loading} disabled={!selectedTemplate || generating}>
            Предпросмотр
          </Button>,
          <Button
            key="print"
            icon={<PrinterOutlined />}
            onClick={runPrint}
            loading={printing}
            disabled={!selectedTemplate || detailIds.length === 0 || generating}
          >
            Печать
          </Button>,
          <Button
            key="generate"
            type="primary"
            icon={<DownloadOutlined />}
            onClick={runGenerate}
            loading={generating}
            disabled={!preview || exportFormats.length === 0}
          >
            Скачать ZIP
          </Button>,
        ]}
        width={680}
        destroyOnClose
      >
        <style>{`
          .cut-label-preview-fit svg {
            display: block;
            max-width: 100%;
            max-height: 58vh;
            width: auto;
            height: auto;
          }
        `}</style>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {detailIds.length === 0 && <Alert type="warning" showIcon message="На листе нет деталей для бирок" />}
          <Select
            style={{ width: '100%' }}
            value={templateId}
            loading={loading}
            onChange={setTemplateId}
            options={templates.map((template) => ({
              value: template.labelTemplateId,
              label: template.isActive ? template.name : `${template.name} (архив)`,
            }))}
            placeholder="Шаблон"
          />
          <Checkbox checked={useBasisFields} onChange={(event) => setUseBasisFields(event.target.checked)}>
            Использовать поля базис проекта
          </Checkbox>
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
              Форматы файлов бирок
            </Text>
            <Checkbox.Group
              options={EXPORT_FORMAT_OPTIONS}
              value={exportFormats}
              onChange={(values) => setExportFormats(values as LabelExportFormat[])}
            />
          </div>
          {preview && (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary">Бирок: {preview.labelCount}. Показана первая.</Text>
              {preview.svgPages.slice(0, 1).map((svg, index) => (
                <div
                  key={index}
                  className="cut-label-preview-fit"
                  style={{
                    alignItems: 'center',
                    border: '1px solid var(--app-border)',
                    display: 'flex',
                    justifyContent: 'center',
                    minHeight: 260,
                    overflow: 'hidden',
                    padding: 12,
                  }}
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
