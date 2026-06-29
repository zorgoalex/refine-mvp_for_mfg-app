import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Typography, message } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';
import { labelsApi } from '../../api/labelsApi';
import type { DetailLabelsPreview, LabelTemplate } from '../../api/types/labelsApi.types';
import { can } from '../../utils/permissions';
import { saveLabelBlob } from '../orders/components/labels/labelDownloads';

const { Text } = Typography;

interface CutSheetLabelGenerateActionProps {
  detailIds: number[];
  cutJobId: number;
  cutGroupId: number;
  sheetIndex: number;
}

export const CutSheetLabelGenerateAction: React.FC<CutSheetLabelGenerateActionProps> = ({
  detailIds,
  cutJobId,
  cutGroupId,
  sheetIndex,
}) => {
  const canGenerate = can('labels.generate');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [useBasisFields, setUseBasisFields] = useState(true);
  const [preview, setPreview] = useState<DetailLabelsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const previewRequestRef = useRef(0);
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.labelTemplateId === templateId) ?? null,
    [templateId, templates],
  );
  const disabled = !canGenerate || detailIds.length === 0;

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
    if (!selectedTemplate || !preview) return;
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
        exportFormats: selectedTemplate.defaultExportFormats,
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
        title={`Бирки листа ${sheetIndex + 1}`}
        open={open}
        onCancel={() => !generating && setOpen(false)}
        footer={[
          <Button key="preview" onClick={runPreview} loading={loading} disabled={!selectedTemplate || generating}>
            Предпросмотр
          </Button>,
          <Button key="generate" type="primary" icon={<DownloadOutlined />} onClick={runGenerate} loading={generating} disabled={!preview}>
            Сформировать и скачать
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
