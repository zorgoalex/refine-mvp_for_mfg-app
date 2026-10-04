import { CopyOutlined, FileTextOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Modal, Select, Space, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isApiError } from '../../api/apiError';
import { supplierTextTemplatesApi } from '../../api/supplierTextTemplatesApi';
import type { SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import type { SupplierTextTemplateDto } from '../../api/types/supplierTextTemplatesApi.types';
import { Tooltip } from '../../ui/tooltipDelay';
import { SupplierTextTemplatesEditor } from './SupplierTextTemplatesEditor';
import { buildSupplierCopyText } from './supplierRequestsHelpers';
import {
  nextTemplatesLoad,
  renderSupplierTextForCard,
  STANDARD_SUPPLIER_TEXT_TEMPLATE,
  supplierCopySource,
  supplierTextDialogText,
  supplierTextDisabledReason,
  templateSelectOptions,
  type SupplierTextTemplatesLoad,
} from './supplierTextTemplate';

/** Что получает действие рядом со «Скопировать» (например, отправка в WhatsApp): текст — ровно как на экране. */
export interface SupplierTextActionContext {
  text: string;
  /** Текст правили руками (отличается от результата шаблона). */
  edited: boolean;
  templateId: number | null;
  templateVersion: number | null;
  requestId: number;
  requestVersion: number;
  /** В заявке есть несохранённые изменения — действие должно быть недоступно. */
  dirty: boolean;
  /** Текст готов: шаблоны загружены и заявка сохранена. */
  ready: boolean;
}

interface SupplierTextDialogProps {
  card: SupplierRequestCardDto;
  /** capabilities.supplierTextTemplates из GET карточки; undefined — старый backend. */
  capability: boolean | undefined;
  /** Несохранённые правки: текст строится по сохранённой заявке, иначе он разошёлся бы с экраном (CR4-3). */
  dirty: boolean;
  /** Дополнительные действия в окне рядом со «Скопировать». */
  renderActions?: (context: SupplierTextActionContext) => ReactNode;
}

/**
 * «Текст для поставщика» (замечания 2026-10-04 п.6, п.7): окно с текстом заявки — шаблон меняется на месте и текст
 * сразу перестраивается, его можно поправить руками и скопировать. Текст не обрезается ни при какой длине.
 */
export function SupplierTextDialog({ card, capability, dirty, renderActions }: SupplierTextDialogProps) {
  const [load, setLoad] = useState<SupplierTextTemplatesLoad<SupplierTextTemplateDto>>({ status: 'loading' });
  /** Выбор шаблона внутри открытого окна; null — действующий по умолчанию. При каждом открытии сбрасывается (code review R1-3). */
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  /** Ручная правка; null — текст следует за шаблоном. */
  const [manual, setManual] = useState<string | null>(null);

  /** Растёт при каждом открытии окна: список шаблонов перечитывается, чтобы выбрать действующий по умолчанию (code review R2-2). */
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (capability !== true) return undefined;
    const controller = new AbortController();
    // Уже прочитанный список остаётся на экране, пока идёт обновление.
    setLoad((current) => nextTemplatesLoad(current, { kind: 'start' }));
    supplierTextTemplatesApi.listVisible({ signal: controller.signal })
      .then((result) => setLoad((current) => nextTemplatesLoad(current, { kind: 'ok', templates: result.templates })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = isApiError(error) ? error.status : 0;
        setLoad((current) => nextTemplatesLoad(current, { kind: 'failed', status }));
      });
    return () => controller.abort();
  }, [capability, refresh]);

  const source = supplierCopySource(capability, load, chosenId);
  const rendered = useMemo(() => {
    if (source.kind === 'legacy') return buildSupplierCopyText(card);
    if (source.kind === 'template') return renderSupplierTextForCard({ body: source.template.body, line: source.template.lineTemplate }, card);
    if (source.kind === 'fallback') return renderSupplierTextForCard(STANDARD_SUPPLIER_TEXT_TEMPLATE, card);
    return null;
  }, [source, card]);
  const { text, edited } = supplierTextDialogText(rendered, manual);
  const template = source.kind === 'template' ? source.template : null;
  const templates = load.status === 'ready' ? load.templates : [];

  const disabledReason = supplierTextDisabledReason(dirty, source);
  const ready = disabledReason === undefined && rendered !== null;

  const copy = async () => {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success('Текст скопирован');
    } catch {
      message.error('Не удалось скопировать — браузер отклонил доступ к буферу обмена');
    }
  };

  const applyTemplate = (templateId: number) => { setChosenId(templateId); setManual(null); };
  const changeTemplate = (templateId: number) => {
    if (!edited) { applyTemplate(templateId); return; }
    Modal.confirm({
      title: 'Сменить шаблон?',
      content: 'Текст изменён вручную — при смене шаблона правки пропадут.',
      okText: 'Сменить',
      cancelText: 'Отмена',
      onOk: () => applyTemplate(templateId),
    });
  };
  const onTemplatesChange = useCallback((next: SupplierTextTemplateDto[]) => setLoad({ status: 'ready', templates: next }), []);

  return (
    <>
      <Tooltip title={disabledReason}>
        <Button icon={<FileTextOutlined />} disabled={!ready} onClick={() => { setManual(null); setChosenId(null); setRefresh((value) => value + 1); setOpen(true); }}>Текст для поставщика</Button>
      </Tooltip>
      <Modal
        open={open}
        width={720}
        title={`Текст для поставщика — заявка ${card.requestNumber}`}
        onCancel={() => setOpen(false)}
        footer={(
          <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => setOpen(false)}>Закрыть</Button>
            {renderActions?.({
              text, edited, templateId: template?.templateId ?? null, templateVersion: template?.version ?? null,
              requestId: card.requestId, requestVersion: card.version, dirty, ready,
            })}
            <Button type="primary" icon={<CopyOutlined />} disabled={!ready || text.length === 0} onClick={() => void copy()}>Скопировать</Button>
          </Space>
        )}
      >
        {source.kind === 'fallback' && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={source.note} />}
        {/* Выбор шаблона и редактор — только когда список шаблонов прочитан; иначе текст стандартный (R6-1). */}
        {load.status === 'ready' && capability === true && (
          <Space style={{ width: '100%', marginBottom: 8 }} wrap>
            <Typography.Text type="secondary">Шаблон:</Typography.Text>
            <Select
              style={{ minWidth: 300 }}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите шаблон"
              aria-label="Шаблон текста"
              disabled={templates.length === 0}
              value={template?.templateId}
              options={templateSelectOptions(templates)}
              onChange={changeTemplate}
            />
            <Button onClick={() => setEditorOpen(true)}>Мои шаблоны…</Button>
          </Space>
        )}
        <Input.TextArea
          aria-label="Текст для поставщика"
          value={text}
          autoSize={{ minRows: 8, maxRows: 20 }}
          onChange={(event) => setManual(event.target.value)}
        />
        <Space style={{ width: '100%', justifyContent: 'space-between', marginTop: 6 }} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {edited ? 'Текст изменён вручную — шаблон и заявка при этом не меняются.' : 'Текст можно поправить перед копированием.'}
          </Typography.Text>
          <Space size={8}>
            {edited && <Button size="small" onClick={() => setManual(null)}>Вернуть текст шаблона</Button>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>символов: {text.length}</Typography.Text>
          </Space>
        </Space>
      </Modal>
      <Modal open={editorOpen} width={820} title="Шаблоны текста поставщику" footer={null} destroyOnClose onCancel={() => setEditorOpen(false)}>
        <SupplierTextTemplatesEditor onTemplatesChange={onTemplatesChange} />
      </Modal>
    </>
  );
}
