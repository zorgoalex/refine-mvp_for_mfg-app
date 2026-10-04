import { Alert, Button, Form, Input, Modal, Popconfirm, Space, Tag, Typography, message } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import type { UserIdentity } from '../../types/auth';
import { ApiError, isApiError } from '../../api/apiError';
import { supplierTextTemplatesApi } from '../../api/supplierTextTemplatesApi';
import type { SupplierTextTemplateCommandResultDto, SupplierTextTemplateDto } from '../../api/types/supplierTextTemplatesApi.types';
import type { SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import {
  renderSupplierTextForCard,
  SUPPLIER_TEXT_BODY_FIELDS,
  SUPPLIER_TEXT_FIELD_HELP,
  SUPPLIER_TEXT_LIMITS,
  SUPPLIER_TEXT_LINE_FIELDS,
  validateTemplate,
} from './supplierTextTemplate';
import {
  confirmedTemplates,
  executeTemplateCommand,
  isBlockedByPending,
  addPendingCommand,
  listPendingCommands,
  pendingForRun,
  pendingLabel,
  removePendingCommand,
  resolveDraftConflict,
  type PendingCommand,
  type TemplateCommandAction,
  type TemplateDraft,
} from './supplierTextTemplatesEditorHelpers';

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

type Load = { status: 'loading' } | { status: 'ready'; templates: SupplierTextTemplateDto[]; editable: boolean; defaultRevision: number } | { status: 'hidden' } | { status: 'error'; message: string };
/** `readOnly` — открыт общий шаблон: только просмотр. */
type Draft = TemplateDraft & { readOnly?: boolean };
type CommandCall = (key: string, body: Record<string, unknown>) => Promise<SupplierTextTemplateCommandResultDto>;

const isOwn = (template: SupplierTextTemplateDto) => template.scope === 'own';

/** Команду не удалось сохранить перед отправкой — запрос не отправлен. */
class PendingNotSavedError extends Error {}

const PENDING_SUCCESS: Record<TemplateCommandAction, string> = {
  create: 'Шаблон создан', update: 'Шаблон сохранён', delete: 'Шаблон удалён', default: 'Шаблон по умолчанию изменён',
};

/** Вызов API для сохранённой команды: по действию и шаблону, тело — исходное (повтор после закрытия окна или перезагрузки). */
function pendingCall(command: PendingCommand): CommandCall {
  const id = command.templateId as number;
  if (command.action === 'create') return (key, body) => supplierTextTemplatesApi.create({ commandKey: key, ...(body as { name: string; body: string; lineTemplate: string }) });
  if (command.action === 'update') return (key, body) => supplierTextTemplatesApi.update(id, { commandKey: key, ...(body as { expectedVersion: number }) });
  if (command.action === 'delete') return (key, body) => supplierTextTemplatesApi.remove(id, { commandKey: key, expectedVersion: body.expectedVersion as number });
  return (key, body) => supplierTextTemplatesApi.setDefault(id, {
    commandKey: key, expectedVersion: body.expectedVersion as number, expectedDefaultRevision: body.expectedDefaultRevision as number,
  });
}

export interface SupplierTextTemplatesEditorProps {
  /** Список изменился (создание, правка, удаление, выбор по умолчанию) — родитель обновляет свой выбор шаблона. */
  onTemplatesChange?: (templates: SupplierTextTemplateDto[]) => void;
}

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

/**
 * Шаблоны текста заявки поставщику на экране снабжения: «Мои» — личные шаблоны пользователя (создать, изменить,
 * удалить), «Общие» — только просмотр и «Скопировать себе»; «по умолчанию» у каждого пользователя своё.
 */
export function SupplierTextTemplatesEditor({ onTemplatesChange }: SupplierTextTemplatesEditorProps = {}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  // Ключ повтора живёт до ответа сервера: повтор того же действия после сетевого сбоя — тот же ключ (R1-1).
  const pending = useRef<PendingCommand | null>(null);
  /** Незавершённая команда для показа и повтора (исход неизвестен, plan review R3-1). */
  const [uncertain, setUncertain] = useState<PendingCommand | null>(null);
  // Команда хранится вне окна, по пользователю: закрытие/повторное открытие редактора её не теряет (code review R1-1).
  const { data: identity } = useGetIdentity<UserIdentity>();
  const userId = identity?.id === undefined || identity?.id === null ? null : String(identity.id);
  useEffect(() => {
    if (userId === null) return;
    // Сохранённая команда без подтверждения (в том числе оборванная перезагрузкой во время запроса) — исход неизвестен.
    const saved = listPendingCommands(userId)[0] ?? null;
    pending.current = saved;
    setUncertain(saved);
  }, [userId]);
  /** Действие подтверждено, но список после него перечитать не удалось: показан прежний список (R5-2). */
  const [stale, setStale] = useState(false);
  const applyTemplates = useCallback((templates: SupplierTextTemplateDto[], editable: boolean, defaultRevision: number) => {
    setLoad({ status: 'ready', templates, editable, defaultRevision });
    onTemplatesChange?.(templates);
  }, [onTemplatesChange]);

  const reload = useCallback(async () => {
    try {
      const result = await supplierTextTemplatesApi.listVisible();
      applyTemplates(result.templates, result.editable, result.defaultRevision);
      setStale(false);
    } catch (error) {
      // Флаг выключен / нет прав — раздел не показываем.
      if (isApiError(error) && [401, 403, 404, 503].includes(error.status)) setLoad({ status: 'hidden' });
      else setLoad({ status: 'error', message: 'Не удалось загрузить шаблоны текста поставщику' });
    }
  }, [applyTemplates]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (
    action: TemplateCommandAction,
    templateId: number | null,
    body: Record<string, unknown>,
    call: CommandCall,
    success: string,
    /** «Повторить»: исходная незавершённая команда — отправляется с её ключом и телом (code review R4-1). */
    retry: PendingCommand | null = null,
  ): Promise<boolean> => {
    // Пока исход прежней команды неизвестен, другая не отправляется (R3-1) — только её повтор или явный сброс.
    if (userId === null) { message.info('Профиль ещё загружается — повторите через секунду'); return false; }
    // Состояние — из общего хранилища: другая вкладка или прежнее окно могли оставить незавершённую команду.
    const plan = pendingForRun(listPendingCommands(userId), retry);
    pending.current = plan.pending;
    if (plan.conflict) {
      setUncertain(plan.conflict);
      message.warning('Есть несколько незавершённых действий с шаблонами — сначала завершите их по очереди');
      return false;
    }
    if (plan.pending) setUncertain(plan.pending);
    if (isBlockedByPending(pending.current, action, templateId, body)) {
      message.warning('Сначала завершите предыдущее действие: повторите его или сбросьте');
      return false;
    }
    setBusy(true);
    try {
      // Команда записывается в хранилище ДО отправки и только под своим ключом (code review R2-1, R5): перезагрузка во
      // время запроса её не теряет; если браузер запись не сохранил — запрос не отправляется.
      let sent: PendingCommand | null = null;
      const done = await executeTemplateCommand(pending.current, action, templateId, body, async (key, sentBody) => {
        if (!sent || !addPendingCommand(userId, sent)) throw new PendingNotSavedError();
        return call(key, sentBody);
      }, () => crypto.randomUUID(), undefined, (command) => { sent = command; });
      const sentCommand = sent as PendingCommand | null;
      if (done.outcome === 'uncertain' && done.error instanceof PendingNotSavedError) {
        // Запрос не уходил: исход известен — ничего не выполнено; показанное состояние — из хранилища.
        pending.current = listPendingCommands(userId)[0] ?? null;
        setUncertain(pending.current);
        message.error('Браузер не смог сохранить действие (хранилище недоступно или переполнено) — оно не отправлено');
        return false;
      }
      // Подтверждение или определённый отказ убирают запись ТОЛЬКО своей команды; при неизвестном исходе запись остаётся.
      if (done.outcome !== 'uncertain' && sentCommand) removePendingCommand(userId, sentCommand.key);
      // После подтверждения/отказа показывается то, что осталось в хранилище (например, команда другой вкладки).
      const left = done.outcome === 'uncertain' ? done.pending : listPendingCommands(userId)[0] ?? null;
      pending.current = left;
      if (done.outcome === 'ok') {
        setUncertain(left);
        // Ответ команды может быть историческим (повтор ключа) — показываем актуальный список (plan review R4-2).
        const current = await confirmedTemplates(() => supplierTextTemplatesApi.listVisible());
        if (current) { applyTemplates(current.templates, current.editable, current.defaultRevision); setStale(false); }
        else setStale(true); // последний прочитанный список остаётся, но помечен устаревшим (R5-2)
        message.success(done.result.changed ? success : 'Изменений нет');
        return true;
      }
      if (done.outcome === 'uncertain') {
        // Результат неизвестен (нет ответа, 5xx, нечитаемый ответ, маршрута нет): команда сохранена — повтор вернёт её результат.
        setUncertain(done.pending);
        message.error('Сервер не подтвердил действие — повторите его, повтор не выполнит его дважды');
        return false;
      }
      setUncertain(left);
      const error = done.error as ApiError;
      if (action === 'update' && (error.code === 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' || error.code === 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND')) {
        // Открытый черновик: показать свежую версию и дать выбрать, правки пользователя не теряются (R1-2).
        const fresh = await freshTemplate(templateId);
        if (fresh !== undefined) {
          setDraft((current) => current && current.templateId === templateId ? { ...current, conflict: { fresh } } : current);
          return false;
        }
      }
      message.error(error.code === 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' ? 'Шаблон уже изменили — показан актуальный список'
        : error.code === 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_CONFLICT' ? 'Шаблон по умолчанию уже меняли — показан актуальный список'
          : (error.message || 'Действие отклонено'));
      await reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Свежая версия шаблона: объект — есть, null — удалён, undefined — список не загрузился. */
  const freshTemplate = async (templateId: number | null) => {
    try {
      const result = await supplierTextTemplatesApi.listVisible();
      applyTemplates(result.templates, result.editable, result.defaultRevision);
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

  if (load.status === 'hidden') return <Alert type="info" showIcon message="Шаблоны текста поставщику сейчас недоступны." />;
  if (load.status === 'loading') return <Paragraph type="secondary">Загружаются шаблоны…</Paragraph>;
  if (load.status === 'error') return <Alert type="error" showIcon message={load.message} action={<Button size="small" onClick={() => void reload()}>Повторить</Button>} />;

  const { templates, editable, defaultRevision } = load;
  const own = templates.filter(isOwn);
  const shared = templates.filter((template) => !isOwn(template));
  const canWrite = editable && uncertain === null && !stale && userId !== null;
  const startDraft = (base: SupplierTextTemplateDto | undefined, name: string) =>
    setDraft({ templateId: null, version: 0, name, body: base?.body ?? '', lineTemplate: base?.lineTemplate ?? '' });
  const chooseDefault = (t: SupplierTextTemplateDto) => {
    void run('default', t.templateId, { expectedVersion: t.version, expectedDefaultRevision: defaultRevision },
      (key, body) => supplierTextTemplatesApi.setDefault(t.templateId, {
        commandKey: key, expectedVersion: body.expectedVersion as number, expectedDefaultRevision: body.expectedDefaultRevision as number,
      }), 'Шаблон по умолчанию изменён');
  };
  const retryUncertain = async () => {
    if (!uncertain) return;
    const command = uncertain;
    const ok = await run(command.action, command.templateId, command.body, pendingCall(command), PENDING_SUCCESS[command.action], command);
    if (ok && (command.action === 'create' || command.action === 'update')) setDraft(null);
  };
  const dropUncertain = () => {
    if (!uncertain || userId === null) return;
    // Сбрасывается только показанная команда — по её ключу (code review R4-2): если в хранилище уже другая (её
    // отправили из другого окна), она остаётся, а предупреждение обновляется.
    const key = uncertain.key;
    Modal.confirm({
      title: 'Сбросить незавершённое действие?',
      content: 'Сервер не подтвердил его: оно могло выполниться, а могло и нет. После сброса список шаблонов будет прочитан заново — проверьте его.',
      okText: 'Сбросить',
      cancelText: 'Отмена',
      onOk: async () => {
        removePendingCommand(userId, key);
        const current = listPendingCommands(userId)[0] ?? null;
        pending.current = current;
        setUncertain(current);
        await reload();
      },
    });
  };
  const save = async () => {
    if (!draft || draft.readOnly || hasErrors || draft.conflict) return;
    const fields = { name: draft.name.trim(), body: draft.body, lineTemplate: draft.lineTemplate };
    const templateId = draft.templateId;
    const ok = templateId === null
      ? await run('create', null, fields, (key, body) => supplierTextTemplatesApi.create({ commandKey: key, ...(body as typeof fields) }), 'Шаблон создан')
      : await run('update', templateId, { ...fields, expectedVersion: draft.version },
        (key, body) => supplierTextTemplatesApi.update(templateId, { commandKey: key, ...(body as typeof fields & { expectedVersion: number }) }), 'Шаблон сохранён');
    if (ok) setDraft(null);
  };

  const columns = (ownList: boolean) => [
    { title: 'Название', dataIndex: 'name', render: (name: string, t: SupplierTextTemplateDto) => <Space>{name}{t.isDefault && <Tag color="blue">по умолчанию</Tag>}</Space> },
    {
      title: '', key: 'actions', width: 360, align: 'right' as const,
      render: (_: unknown, t: SupplierTextTemplateDto) => (
        <Space size={4}>
          <Button size="small" onClick={() => setDraft({ templateId: t.templateId, version: t.version, name: t.name, body: t.body, lineTemplate: t.lineTemplate, readOnly: !ownList || !editable })}>
            {ownList && editable ? 'Изменить' : 'Открыть'}
          </Button>
          {!ownList && editable && (
            <Button size="small" disabled={!canWrite || own.length >= SUPPLIER_TEXT_LIMITS.ownTemplates} onClick={() => startDraft(t, `${t.name} (мой)`.slice(0, SUPPLIER_TEXT_LIMITS.name))}>
              Скопировать себе
            </Button>
          )}
          {editable && !t.isDefault && (
            <Button size="small" disabled={busy || !canWrite} onClick={() => chooseDefault(t)}>По умолчанию</Button>
          )}
          {ownList && editable && (
            <Popconfirm title={`Удалить шаблон «${t.name}»?`} okText="Удалить" cancelText="Отмена"
              onConfirm={() => { void run('delete', t.templateId, { expectedVersion: t.version }, (key, body) => supplierTextTemplatesApi.remove(t.templateId, { commandKey: key, expectedVersion: body.expectedVersion as number }), 'Шаблон удалён'); }}>
              <Button size="small" danger disabled={busy || !canWrite}>Удалить</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {!editable && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Личные шаблоны временно недоступны — доступны общие шаблоны, только для чтения." />
      )}
      {stale && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Действие выполнено, но список не удалось обновить — он мог устареть"
          action={<Button size="small" onClick={() => void reload()}>Обновить</Button>}
        />
      )}
      {uncertain && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`Сервер не подтвердил действие: ${pendingLabel(uncertain)}`}
          description="Оно могло выполниться. Повторите его — повтор не выполнит действие дважды. Другие действия с шаблонами до этого недоступны."
          action={(
            <Space direction="vertical" size={4}>
              <Button size="small" type="primary" loading={busy} onClick={() => void retryUncertain()}>Повторить</Button>
              <Button size="small" disabled={busy} onClick={dropUncertain}>Сбросить</Button>
            </Space>
          )}
        />
      )}
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong>Мои шаблоны</Text>
        {editable && (
          <Button
            size="small"
            type="primary"
            disabled={!canWrite || own.length >= SUPPLIER_TEXT_LIMITS.ownTemplates}
            onClick={() => startDraft(templates.find((t) => t.isDefault) ?? templates[0], '')}
          >
            Создать шаблон
          </Button>
        )}
      </Space>
      <Table<SupplierTextTemplateDto>
        size="small"
        rowKey="templateId"
        pagination={false}
        dataSource={own}
        columns={columns(true)}
        locale={{ emptyText: editable ? 'Своих шаблонов пока нет — создайте новый или скопируйте общий' : 'Нет данных' }}
      />
      <Paragraph type="secondary" style={{ margin: '4px 0 12px', fontSize: 12 }}>
        Свои шаблоны видите и меняете только вы (не больше {SUPPLIER_TEXT_LIMITS.ownTemplates}). «По умолчанию» — тоже ваш личный выбор.
      </Paragraph>
      <Text strong>Общие шаблоны</Text>
      <Table<SupplierTextTemplateDto>
        size="small"
        rowKey="templateId"
        pagination={false}
        dataSource={shared}
        columns={columns(false)}
        style={{ marginTop: 8 }}
      />
      <Modal
        open={draft !== null}
        width={760}
        title={draft?.templateId === null ? 'Новый шаблон' : draft?.readOnly ? 'Общий шаблон (только просмотр)' : 'Мой шаблон'}
        okText="Сохранить"
        cancelText={draft?.readOnly ? 'Закрыть' : 'Отмена'}
        okButtonProps={{ disabled: !canWrite || hasErrors || !!draft?.conflict, loading: busy, style: draft?.readOnly ? { display: 'none' } : undefined }}
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
          <Form layout="vertical" disabled={draft.readOnly === true}>
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
    </div>
  );
}
