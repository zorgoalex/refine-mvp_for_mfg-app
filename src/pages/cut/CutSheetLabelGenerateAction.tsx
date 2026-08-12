import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Tooltip, Typography, message } from 'antd';
import { DownloadOutlined, PrinterOutlined, TagsOutlined } from '@ant-design/icons';
import { authSession } from '../../api/authSession';
import { labelsApi } from '../../api/labelsApi';
import type { DetailLabelsPreview, LabelExportFormat, LabelTemplate } from '../../api/types/labelsApi.types';
import { can } from '../../utils/permissions';
import { saveLabelBlob } from '../orders/components/labels/labelDownloads';
import { printLabelSvgPages } from '../orders/components/labels/labelPrint';
import {
  resolvePreferredLabelTemplateId,
  saveLabelTemplatePreference,
} from '../orders/components/labels/labelTemplatePreference';

const { Text } = Typography;

/** Selectable export file formats for generated labels (checkboxes in the modal). */
const EXPORT_FORMAT_OPTIONS: { value: LabelExportFormat; label: string }[] = [
  { value: 'bmp', label: 'BMP' },
  { value: 'png', label: 'PNG' },
  { value: 'emf', label: 'EMF' },
];

interface CutSheetLabelGenerateActionProps {
  detailIds: number[];
  cutJobId: number;
  cutGroupId: number;
  sheetIndex: number;
  labelCoverage?: CutSheetLabelCoverage | null;
}

export interface CutSheetLabelCoverageIssue {
  key: string;
  label: string;
  expectedQuantity: number;
  includedQuantity: number;
  missingQuantity: number;
  reason: string;
}

export interface CutSheetLabelCoverage {
  expectedCount: number;
  includedCount: number;
  issues: CutSheetLabelCoverageIssue[];
}

export const CutSheetLabelGenerateAction: React.FC<CutSheetLabelGenerateActionProps> = ({
  detailIds,
  cutJobId,
  cutGroupId,
  sheetIndex,
  labelCoverage,
}) => {
  const canGenerate = can('labels.generate');
  const labelTemplatePreferenceUserId = authSession.getUser()?.id ?? 'anon';
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
  const disabled = !canGenerate || detailIds.length === 0;
  const incompleteCoverage = Boolean(labelCoverage && labelCoverage.issues.length > 0);
  const buttonLabel = incompleteCoverage && labelCoverage
    ? `Бирки ${labelCoverage.includedCount}/${labelCoverage.expectedCount}`
    : 'Бирки';
  const omittedPreview = labelCoverage?.issues.slice(0, 8) ?? [];
  const omittedRestCount = Math.max(0, (labelCoverage?.issues.length ?? 0) - omittedPreview.length);
  const button = (
    <Button
      className="app-hit-area-sm"
      size="small"
      icon={<TagsOutlined />}
      disabled={disabled}
      onClick={() => setOpen(true)}
    >
      {buttonLabel}
    </Button>
  );

  // Seed the export-format checkboxes from the selected template's defaults
  // whenever the chosen template changes; the operator can then toggle them.
  useEffect(() => {
    if (selectedTemplate) setExportFormats(selectedTemplate.defaultExportFormats);
  }, [selectedTemplate?.labelTemplateId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    labelsApi.listTemplates()
      .then((next) => {
        // A cut-map label is intentionally configured from the order card,
        // where every physical copy can be bound to an exact immutable
        // placement. The sheet shortcut scopes labels by detail IDs from the
        // visible sheet, without a persisted per-copy placement binding.
        const supported = next.filter(
          (template) => template.isActive && !template.elements.some((element) => element.kind === 'cut_map'),
        );
        setTemplates(supported);
        setTemplateId(resolvePreferredLabelTemplateId(labelTemplatePreferenceUserId, supported));
      })
      .catch(() => message.error('Не удалось загрузить шаблоны бирок'))
      .finally(() => setLoading(false));
  }, [labelTemplatePreferenceUserId, open]);

  const runPreview = useCallback(async () => {
    if (!selectedTemplate || detailIds.length === 0) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setLoading(true);
    try {
      const nextPreview = await labelsApi.previewDetailLabels({
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        detailIds,
        useBasisFields,
      });
      if (previewRequestRef.current === requestId) setPreview(nextPreview);
    } catch {
      if (previewRequestRef.current === requestId) message.error('Не удалось построить предпросмотр бирок');
    } finally {
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  }, [detailIds, selectedTemplate, useBasisFields]);

  useEffect(() => {
    if (!open || !selectedTemplate || generating) return;
    void runPreview();
  }, [generating, open, runPreview, selectedTemplate, useBasisFields]);

  const runGenerate = async () => {
    if (!selectedTemplate || !preview || exportFormats.length === 0) return;
    setGenerating(true);
    try {
      const generationPreview = await labelsApi.previewDetailLabels({
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        detailIds,
        useBasisFields,
      });
      const generation = await labelsApi.generateDetailLabels({
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        detailIds,
        previewToken: generationPreview.previewToken,
        exportFormats,
        useBasisFields,
        idempotencyKey: `cut-sheet-labels-${cutJobId}-${cutGroupId}-${sheetIndex}-${Date.now()}`,
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
        templateId: selectedTemplate.labelTemplateId,
        templateVersion: selectedTemplate.version,
        detailIds,
        useBasisFields,
      });
      setPreview(printPreview);
      const printed = printLabelSvgPages(printPreview.svgPages, `Бирки листа ${sheetIndex + 1}`);
      if (!printed) message.warning('Нет бирок для печати');
    } catch {
      message.error('Не удалось открыть печать бирок');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <>
      {incompleteCoverage && labelCoverage ? (
        <Tooltip title={`Неполный комплект: будет ${labelCoverage.includedCount} из ${labelCoverage.expectedCount} бирок`}>
          {button}
        </Tooltip>
      ) : button}
      <Modal
        title={`Бирки листа ${sheetIndex + 1}`}
        open={open}
        onCancel={() => !generating && setOpen(false)}
        footer={[
          <Button key="preview" onClick={runPreview} loading={loading} disabled={!selectedTemplate || generating}>
            Обновить предпросмотр
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
          {incompleteCoverage && labelCoverage && (
            <Alert
              type="warning"
              showIcon
              message={`Неполный комплект: будет сформировано ${labelCoverage.includedCount} из ${labelCoverage.expectedCount} бирок`}
              description={(
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Text type="secondary">
                    Генерация доступна. Ниже детали, для которых бирки не попадут в этот комплект.
                  </Text>
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {omittedPreview.map((issue) => (
                      <li key={issue.key}>
                        <Text strong>{issue.label}</Text>
                        <Text type="secondary">
                          {` — нет ${issue.missingQuantity} из ${issue.expectedQuantity}. ${issue.reason}`}
                        </Text>
                      </li>
                    ))}
                  </ul>
                  {omittedRestCount > 0 && (
                    <Text type="secondary">Ещё {omittedRestCount} строк без бирок.</Text>
                  )}
                </Space>
              )}
            />
          )}
          <Alert
            type="info"
            showIcon
            message="Шаблоны с миниатюрой раскроя доступны в карточке заказа"
            description="Там раскрой выбирается отдельно для каждого физического экземпляра детали."
          />
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
