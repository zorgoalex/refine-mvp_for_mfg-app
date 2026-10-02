import { CopyOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Modal, Select, Space, Typography, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '../../api/apiError';
import { supplierTextTemplatesApi } from '../../api/supplierTextTemplatesApi';
import type { SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import type { SupplierTextTemplateDto } from '../../api/types/supplierTextTemplatesApi.types';
import { Tooltip } from '../../ui/tooltipDelay';
import { buildSupplierCopyText } from './supplierRequestsHelpers';
import {
  readStoredTemplateId,
  renderSupplierTextForCard,
  STANDARD_SUPPLIER_TEXT_TEMPLATE,
  storeTemplateId,
  supplierCopySource,
  type SupplierTextTemplatesLoad,
} from './supplierTextTemplate';

interface SupplierTextCopyProps {
  card: SupplierRequestCardDto;
  /** capabilities.supplierTextTemplates из GET карточки; undefined — старый backend. */
  capability: boolean | undefined;
  /** Несохранённые правки: копируется сохранённая заявка, иначе текст разошёлся бы с экраном (CR4-3). */
  dirty: boolean;
}

/** «Скопировать текст для поставщика» с выбором шаблона и предпросмотром (план шаблонов §1, §6). */
export function SupplierTextCopy({ card, capability, dirty }: SupplierTextCopyProps) {
  const [load, setLoad] = useState<SupplierTextTemplatesLoad<SupplierTextTemplateDto>>({ status: 'loading' });
  const [storedId, setStoredId] = useState<number | null>(() => readStoredTemplateId());
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (capability !== true) return undefined;
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    supplierTextTemplatesApi.list({ signal: controller.signal })
      .then((result) => setLoad({ status: 'ready', templates: result.templates }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = isApiError(error) ? error.status : 0;
        setLoad(status === 401 || status === 403 ? { status: 'denied' } : { status: 'error' });
      });
    return () => controller.abort();
  }, [capability]);

  const source = supplierCopySource(capability, load, storedId);
  const text = useMemo(() => {
    if (source.kind === 'legacy') return buildSupplierCopyText(card);
    if (source.kind === 'template') return renderSupplierTextForCard({ body: source.template.body, line: source.template.lineTemplate }, card);
    if (source.kind === 'fallback') return renderSupplierTextForCard(STANDARD_SUPPLIER_TEXT_TEMPLATE, card);
    return null;
  }, [source, card]);

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(source.kind === 'fallback' ? `Текст скопирован. ${source.note}` : 'Текст скопирован');
    } catch {
      message.error('Не удалось скопировать — браузер отклонил доступ к буферу обмена');
    }
  };

  const disabledReason = dirty ? 'Сначала сохраните изменения'
    : source.kind === 'denied' ? source.note
      : source.kind === 'loading' ? 'Загружаются шаблоны…' : undefined;
  const templates = load.status === 'ready' ? load.templates : [];

  return (
    <Space size={4} wrap>
      {source.kind === 'template' && templates.length > 1 && (
        <Select
          size="small"
          style={{ minWidth: 180 }}
          value={source.template.templateId}
          aria-label="Шаблон текста"
          options={templates.map((t) => ({ value: t.templateId, label: t.isDefault ? `${t.name} (по умолчанию)` : t.name }))}
          onChange={(value: number) => { setStoredId(value); storeTemplateId(value); }}
        />
      )}
      <Tooltip title={disabledReason ?? (source.kind === 'fallback' ? source.note : undefined)}>
        <Button icon={<CopyOutlined />} disabled={disabledReason !== undefined} onClick={() => void copy()}>Скопировать текст для поставщика</Button>
      </Tooltip>
      {text !== null && (
        <Tooltip title="Предпросмотр текста">
          <Button icon={<EyeOutlined />} aria-label="Предпросмотр текста" disabled={dirty} onClick={() => setPreviewOpen(true)} />
        </Tooltip>
      )}
      <Modal
        open={previewOpen}
        title={source.kind === 'template' ? `Текст для поставщика — ${source.template.name}` : 'Текст для поставщика'}
        okText="Скопировать"
        cancelText="Закрыть"
        onOk={() => { void copy(); setPreviewOpen(false); }}
        onCancel={() => setPreviewOpen(false)}
      >
        {source.kind === 'fallback' && <Typography.Paragraph type="secondary">{source.note}</Typography.Paragraph>}
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{text}</pre>
      </Modal>
    </Space>
  );
}
