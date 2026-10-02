import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Space, Tag, Typography, message } from 'antd';
import { Table } from '../../../ui/tooltipDelay';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '../../../api/apiError';
import { supplierTextTemplatesApi } from '../../../api/supplierTextTemplatesApi';
import type { SupplierTextTemplateCommandResultDto, SupplierTextTemplateDto } from '../../../api/types/supplierTextTemplatesApi.types';
import type { SupplierRequestCardDto } from '../../../api/types/supplierRequestsApi.types';
import {
  renderSupplierTextForCard,
  SUPPLIER_TEXT_BODY_FIELDS,
  SUPPLIER_TEXT_FIELD_HELP,
  SUPPLIER_TEXT_LIMITS,
  SUPPLIER_TEXT_LINE_FIELDS,
  validateTemplate,
} from '../../procurement_workspace/supplierTextTemplate';
import { executeTemplateCommand, resolveDraftConflict, type PendingCommand, type TemplateCommandAction, type TemplateDraft } from './supplierTextTemplatesEditorHelpers';

const { Paragraph, Text } = Typography;

/** Пример заявки для предпросмотра (вымышленные данные). */
const SAMPLE_CARD = {
  requestNumber: 'ЗП-26-0042',
  supplierName: 'ТОО «Пример Плит»',
  expectedDate: '2026-10-09',
  comment: 'Доставка до 12:00',
  sentAt: null,
  createdAt: '2026-10-02T06:00:00.000Z',
  lineItems: [
    { name: 'МДФ 16 мм белый', quantity: 12, unit: 'sheet' },
    { name: 'Плёнка дуб сонома', quantity: 35.5, unit: 'lm' },
  ],
} as unknown as Pick<SupplierRequestCardDto, 'requestNumber' | 'supplierName' | 'expectedDate' | 'comment' | 'lineItems' | 'sentAt' | 'createdAt'>;

type Load = { status: 'loading' } | { status: 'ready'; templates: SupplierTextTemplateDto[]; canManage: boolean } | { status: 'hidden' } | { status: 'error'; message: string };
type Draft = TemplateDraft;

const ERROR_TEXT: Record<string, string> = {
  UNCLOSED_BRACE: 'незакрытая «{» — для самой скобки пишите «{{»',
  STRAY_BRACE: 'одиночная «}» — для самой скобки пишите «}}»',
  UNKNOWN_FIELD: 'неизвестное поле',
  BAD_FIELD: 'пустое или неверное имя поля',
};

export function templateError(value: string, scope: 'body' | 'line', limit: number): string | null {
  if (!value.trim()) return 'Заполните поле';
  if (value.length > limit) return `Не длиннее ${limit} символов`;
  const error = validateTemplate(value, scope);
  return error ? `${ERROR_TEXT[error.code] ?? error.code}${error.detail ? `: ${error.detail}` : ''}` : null;
}

/** «Конфигурация → Закупки»: шаблоны текста заявки поставщику (видны с procurement.view, правка — procurement.manage). */
export function SupplierTextTemplatesEditor() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  // Ключ повтора живёт до ответа сервера: повтор того же действия после сетевого сбоя — тот же ключ (R1-1).
  const pending = useRef<PendingCommand | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await supplierTextTemplatesApi.list();
      setLoad({ status: 'ready', templates: result.templates, canManage: result.canManage });
    } catch (error) {
      // Флаг выключен / старый backend / нет прав — раздел не показываем.
      if (isApiError(error) && [401, 403, 404, 503].includes(error.status)) setLoad({ status: 'hidden' });
      else setLoad({ status: 'error', message: 'Не удалось загрузить шаблоны текста поставщику' });
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (
    action: TemplateCommandAction,
    templateId: number | null,
    body: Record<string, unknown>,
    call: (key: string, body: Record<string, unknown>) => Promise<SupplierTextTemplateCommandResultDto>,
    success: string,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const done = await executeTemplateCommand(pending.current, action, templateId, body, call, () => crypto.randomUUID());
      pending.current = done.pending;
      if (done.outcome === 'ok') {
        setLoad((prev) => ({ status: 'ready', templates: done.result.templates, canManage: prev.status === 'ready' ? prev.canManage : true }));
        message.success(done.result.changed ? success : 'Изменений нет');
        return true;
      }
      if (done.outcome === 'uncertain') {
        // Результат неизвестен (нет ответа, 5xx, нечитаемый ответ): команда сохранена — повтор вернёт её результат.
        message.error('Сервер не подтвердил действие — повторите его, повтор не выполнит его дважды');
        return false;
      }
      const error = done.error as ApiError;
      if (action === 'update' && (error.code === 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' || error.code === 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND')) {
        // Открытый черновик: показать свежую версию и дать выбрать, правки пользователя не теряются (R1-2).
        const fresh = await freshTemplate(templateId);
        if (fresh !== undefined) {
          setDraft((current) => current && current.templateId === templateId ? { ...current, conflict: { fresh } } : current);
          return false;
        }
      }
      message.error(error.code === 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' ? 'Шаблон уже изменили — показан актуальный список' : (error.message || 'Действие отклонено'));
      await reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Свежая версия шаблона: объект — есть, null — удалён, undefined — список не загрузился. */
  const freshTemplate = async (templateId: number | null) => {
    try {
      const result = await supplierTextTemplatesApi.list();
      setLoad({ status: 'ready', templates: result.templates, canManage: result.canManage });
      const fresh = result.templates.find((t) => t.templateId === templateId);
      return fresh ? { version: fresh.version, name: fresh.name, body: fresh.body, lineTemplate: fresh.lineTemplate } : null;
    } catch {
      return undefined;
    }
  };

  const errors = useMemo(() => draft && {
    name: !draft.name.trim() ? 'Заполните название' : draft.name.trim().length > SUPPLIER_TEXT_LIMITS.name ? `Не длиннее ${SUPPLIER_TEXT_LIMITS.name} символов` : null,
    body: templateError(draft.body, 'body', SUPPLIER_TEXT_LIMITS.body),
    lineTemplate: templateError(draft.lineTemplate, 'line', SUPPLIER_TEXT_LIMITS.line),
  }, [draft]);
  const hasErrors = !!errors && Object.values(errors).some(Boolean);
  const preview = draft && !hasErrors ? renderSupplierTextForCard({ body: draft.body, line: draft.lineTemplate }, SAMPLE_CARD) : '';

  if (load.status === 'hidden') return null;
  if (load.status === 'loading') return <Card size="small" title="Шаблоны текста поставщику" loading />;
  if (load.status === 'error') return <Alert type="error" showIcon message={load.message} action={<Button size="small" onClick={() => void reload()}>Повторить</Button>} />;

  const { templates, canManage } = load;
  const save = async () => {
    if (!draft || hasErrors || draft.conflict) return;
    const fields = { name: draft.name.trim(), body: draft.body, lineTemplate: draft.lineTemplate };
    const templateId = draft.templateId;
    const ok = templateId === null
      ? await run('create', null, fields, (key, body) => supplierTextTemplatesApi.create({ commandKey: key, ...(body as typeof fields) }), 'Шаблон создан')
      : await run('update', templateId, { ...fields, expectedVersion: draft.version },
        (key, body) => supplierTextTemplatesApi.update(templateId, { commandKey: key, ...(body as typeof fields & { expectedVersion: number }) }), 'Шаблон сохранён');
    if (ok) setDraft(null);
  };

  return (
    <Card
      size="small"
      title="Шаблоны текста поставщику"
      extra={canManage && (
        <Button
          size="small"
          disabled={templates.length >= SUPPLIER_TEXT_LIMITS.activeTemplates}
          onClick={() => {
            const base = templates.find((t) => t.isDefault) ?? templates[0];
            setDraft({ templateId: null, version: 0, name: '', body: base?.body ?? '', lineTemplate: base?.lineTemplate ?? '' });
          }}
        >
          Создать шаблон
        </Button>
      )}
    >
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Шаблон выбирается в карточке заявки у кнопки «Скопировать текст для поставщика».
      </Paragraph>
      <Table<SupplierTextTemplateDto>
        size="small"
        rowKey="templateId"
        pagination={false}
        dataSource={templates}
        columns={[
          { title: 'Название', dataIndex: 'name', render: (name: string, t) => <Space>{name}{t.isDefault && <Tag color="blue">по умолчанию</Tag>}</Space> },
          {
            title: '', key: 'actions', width: 320, align: 'right',
            render: (_: unknown, t) => (
              <Space size={4}>
                <Button size="small" onClick={() => { setDraft({ templateId: t.templateId, version: t.version, name: t.name, body: t.body, lineTemplate: t.lineTemplate }); }}>
                  {canManage ? 'Изменить' : 'Открыть'}
                </Button>
                {canManage && !t.isDefault && (
                  <Button size="small" disabled={busy} onClick={() => { void run('default', t.templateId, { expectedVersion: t.version }, (key, body) => supplierTextTemplatesApi.setDefault(t.templateId, { commandKey: key, expectedVersion: body.expectedVersion as number }), 'Шаблон по умолчанию изменён'); }}>
                    По умолчанию
                  </Button>
                )}
                {canManage && !t.isDefault && (
                  <Popconfirm title={`Удалить шаблон «${t.name}»?`} okText="Удалить" cancelText="Отмена"
                    onConfirm={() => { void run('delete', t.templateId, { expectedVersion: t.version }, (key, body) => supplierTextTemplatesApi.remove(t.templateId, { commandKey: key, expectedVersion: body.expectedVersion as number }), 'Шаблон удалён'); }}>
                    <Button size="small" danger disabled={busy}>Удалить</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={draft !== null}
        width={760}
        title={draft?.templateId === null ? 'Новый шаблон' : 'Шаблон текста поставщику'}
        okText="Сохранить"
        cancelText={canManage ? 'Отмена' : 'Закрыть'}
        okButtonProps={{ disabled: !canManage || hasErrors || !!draft?.conflict, loading: busy, style: canManage ? undefined : { display: 'none' } }}
        onOk={() => void save()}
        onCancel={() => setDraft(null)}
      >
        {draft?.conflict && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={draft.conflict.fresh ? `Шаблон уже изменили (версия ${draft.conflict.fresh.version}). Ваши правки не сохранены.` : 'Шаблон уже удалён. Ваши правки не сохранены.'}
            description={(
              <Space wrap>
                {draft.conflict.fresh && <Button size="small" onClick={() => setDraft(resolveDraftConflict(draft, 'theirs'))}>Взять сохранённую версию</Button>}
                {draft.conflict.fresh && <Button size="small" onClick={() => setDraft(resolveDraftConflict(draft, 'mine'))}>Оставить мои правки (перезаписать)</Button>}
                <Button size="small" onClick={() => setDraft(resolveDraftConflict(draft, 'copy'))}>Сохранить мои правки как новый шаблон</Button>
              </Space>
            )}
          />
        )}
        {draft && errors && (
          <Form layout="vertical" disabled={!canManage}>
            <Form.Item label="Название" validateStatus={errors.name ? 'error' : undefined} help={errors.name}>
              <Input value={draft.name} maxLength={SUPPLIER_TEXT_LIMITS.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Form.Item>
            <Form.Item label="Текст" validateStatus={errors.body ? 'error' : undefined} help={errors.body}>
              <Input.TextArea value={draft.body} autoSize={{ minRows: 4, maxRows: 12 }} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </Form.Item>
            <Form.Item label="Строка позиции (повторяется для каждой позиции в поле {позиции})" validateStatus={errors.lineTemplate ? 'error' : undefined} help={errors.lineTemplate}>
              <Input value={draft.lineTemplate} onChange={(e) => setDraft({ ...draft, lineTemplate: e.target.value })} />
            </Form.Item>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              Поля текста: {SUPPLIER_TEXT_BODY_FIELDS.map((f) => <Text key={f} code title={SUPPLIER_TEXT_FIELD_HELP[f]}>{`{${f}}`}</Text>)}
              <br />
              Поля строки позиции: {SUPPLIER_TEXT_LINE_FIELDS.map((f) => <Text key={f} code title={SUPPLIER_TEXT_FIELD_HELP[f]}>{`{${f}}`}</Text>)}
              <br />
              Строка шаблона с пустым полем (например, без даты) не выводится. Фигурные скобки как текст: {'{{'} и {'}}'}.
            </Paragraph>
            <Text strong>Предпросмотр на примере заявки</Text>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.03))', padding: 8, borderRadius: 4, minHeight: 60 }}>
              {hasErrors ? 'Исправьте ошибки, чтобы увидеть текст' : preview}
            </pre>
          </Form>
        )}
      </Modal>
    </Card>
  );
}
