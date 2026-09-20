import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { Table } from '../../ui/tooltipDelay';
import {
  bitrix24StagesApi as api,
  type StageJob,
  type StageSettingsInput,
  type StageState,
} from '../../api/bitrix24StagesApi';

const labels: Record<string, string> = {
  pending: 'Ожидает',
  processing: 'Передаётся',
  processed: 'Передано',
  waiting_mapping: 'Ожидает сделки',
  blocked: 'Заблокировано',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Не удалось выполнить действие со стадиями';

/** Independent from payment/user settings: an upstream catalog failure must not hide other sections. */
export function OrderStageSettings() {
  const [state, setState] = useState<StageState | null>(null),
    [draft, setDraft] = useState<StageSettingsInput | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [job, setJob] = useState<StageJob | null>(null),
    [selected, setSelected] = useState<React.Key[]>([]);
  const [provision, setProvision] = useState<number[]>([]),
    [reviewed, setReviewed] = useState(false),
    [retryId, setRetryId] = useState('');
  const accept = (value: StageState) => {
    setState(value);
    setDraft({
      version: value.config.version,
      categoryId:
        value.config.category_id ?? value.catalogs[0]?.category_id ?? 0,
      completedStatusId:
        value.config.completed_status_id ??
        value.statuses.find(
          (s) => s.name.trim().toLowerCase().replace(/ё/g, 'е') === 'завершен'
        )?.id ??
        0,
      enabled: value.config.enabled,
      mappings: value.mappings.map((m) => ({
        orderStatusId: m.order_status_id,
        stageId: m.stage_id,
      })),
    });
  };
  useEffect(() => {
    let alive = true;
    api
      .state()
      .then((v) => {
        if (alive) accept(v);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (value: StageJob) => {
    setJob(value);
    setSelected([]);
    setReviewed(false);
  };
  const catalog = state?.catalogs.find(
    (c) =>
      c.category_id === draft?.categoryId &&
      (!state.config.member_id || state.config.member_id === c.member_id)
  );
  const apply = () =>
    run(async () => {
      if (!job) return;
      if (job.kind === 'settings') {
        accept(await api.applySettings(job.job_id));
        setJob(null);
      } else if (job.kind === 'provision') {
        setJob(await api.applyProvision(job.job_id));
        accept(await api.state());
      } else setJob(await api.applyReconcile(job.job_id, selected.map(String)));
    });
  return (
    <>
      <Collapse>
        <Collapse.Panel
          key="stages"
          header="Статусы заказов ERP → стадии сделок Bitrix"
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {error && (
              <Alert
                type="error"
                showIcon
                message="Стадии заказов"
                description={error}
              />
            )}
            <Space wrap>
              <Button
                loading={busy}
                onClick={() => void run(async () => accept(await api.state()))}
              >
                Обновить состояние стадий
              </Button>
              <Button
                loading={busy}
                onClick={() =>
                  void run(async () => accept(await api.refresh()))
                }
              >
                Загрузить воронки и стадии Bitrix
              </Button>
            </Space>
            {loading ? (
              <Spin />
            ) : (
              draft &&
              state && (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message="Только производственные заказы"
                    description="ERP управляет стадией связанной сделки. Ручные изменения в Bitrix будут восстановлены. CRM-заявки и черновики не меняются. Включение не запускает массовую передачу старых заказов."
                  />
                  <Space wrap>
                    {state.counts.map((x) => (
                      <Tag key={x.status}>
                        {labels[x.status] ?? x.status}: {x.count}
                      </Tag>
                    ))}
                    {!state.counts.length && (
                      <Typography.Text type="secondary">
                        В очереди стадий пока нет заказов
                      </Typography.Text>
                    )}
                  </Space>
                  <Form layout="vertical">
                    <Form.Item label="Существующая воронка Bitrix">
                      <Select
                        aria-label="Существующая воронка Bitrix"
                        value={catalog ? draft.categoryId : undefined}
                        disabled={busy || state.config.binding_locked}
                        onChange={(categoryId) =>
                          setDraft({ ...draft, categoryId, mappings: [] })
                        }
                        options={state.catalogs
                          .filter((c) => c.stages.length)
                          .map((c) => ({
                            value: c.category_id,
                            label: `${c.category_name} (#${c.category_id})`,
                          }))}
                      />
                    </Form.Item>
                    <Typography.Paragraph type="secondary">
                      После первого включения смена воронки заблокирована.
                      Сделки между воронками не перемещаются.
                    </Typography.Paragraph>
                    <Form.Item label="Статус ERP «Завершен» — единственный успешный">
                      <Select
                        aria-label="Завершённый статус ERP"
                        value={draft.completedStatusId || undefined}
                        disabled={busy}
                        onChange={(completedStatusId) =>
                          setDraft({
                            ...draft,
                            completedStatusId,
                            mappings: [],
                          })
                        }
                        options={state.statuses
                          .filter(
                            (s) =>
                              s.name.trim().toLowerCase().replace(/ё/g, 'е') ===
                              'завершен'
                          )
                          .map((s) => ({
                            value: s.id,
                            label: `${s.name} (#${s.id})`,
                          }))}
                      />
                    </Form.Item>
                    <Table
                      size="small"
                      pagination={false}
                      rowKey="id"
                      dataSource={state.statuses}
                      columns={[
                        {
                          title: 'Статус заказа ERP',
                          dataIndex: 'name',
                          render: (name: string, row) => (
                            <span>
                              {name}
                              {!row.active && (
                                <Tag>
                                  Неактивен{row.used ? ', используется' : ''}
                                </Tag>
                              )}
                            </span>
                          ),
                        },
                        {
                          title: 'Стадия сделки Bitrix',
                          render: (_, row) => (
                            <Select
                              aria-label={`Стадия для ${row.name}`}
                              allowClear
                              style={{ width: '100%', minWidth: 180 }}
                              disabled={busy || !catalog}
                              value={
                                draft.mappings.find(
                                  (m) => m.orderStatusId === row.id
                                )?.stageId
                              }
                              onChange={(stageId) =>
                                setDraft({
                                  ...draft,
                                  mappings: [
                                    ...draft.mappings.filter(
                                      (m) => m.orderStatusId !== row.id
                                    ),
                                    ...(stageId
                                      ? [{ orderStatusId: row.id, stageId }]
                                      : []),
                                  ],
                                })
                              }
                              options={catalog?.stages
                                .filter(
                                  (s) =>
                                    s.semantics ===
                                    (row.id === draft.completedStatusId
                                      ? 'S'
                                      : '')
                                )
                                .map((s) => ({
                                  value: s.id,
                                  label: `${s.name} (${s.id})`,
                                }))}
                            />
                          ),
                        },
                      ]}
                    />
                    <Typography.Paragraph type="secondary">
                      «Выдан» остаётся рабочей стадией. Возврат ERP на ранний
                      статус может повторно открыть сделку.
                    </Typography.Paragraph>
                    <Form.Item label="Передавать изменения статусов">
                      <Switch
                        checked={draft.enabled}
                        disabled={busy}
                        onChange={(enabled) => setDraft({ ...draft, enabled })}
                      />
                    </Form.Item>
                    <Button
                      type="primary"
                      disabled={!catalog || busy || !draft.completedStatusId}
                      onClick={() =>
                        void run(async () =>
                          open(await api.previewSettings(draft))
                        )
                      }
                    >
                      Предпросмотр изменения настроек
                    </Button>
                  </Form>
                  <Typography.Title level={5}>
                    Недостающие рабочие стадии
                  </Typography.Title>
                  <Select
                    mode="multiple"
                    aria-label="Создать рабочие стадии для статусов"
                    placeholder="Выберите статусы ERP"
                    style={{ width: '100%' }}
                    value={provision}
                    disabled={busy}
                    onChange={setProvision}
                    options={state.statuses
                      .filter((s) => s.id !== state.config.completed_status_id)
                      .map((s) => ({ value: s.id, label: s.name }))}
                  />
                  <Button
                    disabled={
                      busy ||
                      !provision.length ||
                      state.config.category_id == null
                    }
                    onClick={() =>
                      void run(async () =>
                        open(await api.previewProvision(provision))
                      )
                    }
                  >
                    Предпросмотр создания стадий
                  </Button>
                  <Typography.Text type="secondary">
                    Сначала сохраните воронку с выключенной передачей. Создаются
                    только рабочие стадии; существующие не переименовываются и
                    не переставляются. Затем обновите сопоставление.
                  </Typography.Text>
                  <Typography.Title level={5}>
                    Ранее созданные сделки
                  </Typography.Title>
                  {!!state.jobs?.length && (
                    <Select
                      aria-label="Ранее выполненные операции стадий"
                      placeholder="Ранее выполненные операции"
                      style={{ width: '100%' }}
                      disabled={busy}
                      value={undefined}
                      onChange={(id) =>
                        void run(async () => open(await api.job(id)))
                      }
                      options={state.jobs.map((j) => ({
                        value: j.job_id,
                        label: `${new Date(j.created_at).toLocaleString(
                          'ru-RU'
                        )} · ${j.kind} · ${j.job_id}`,
                      }))}
                    />
                  )}
                  <Button
                    disabled={busy || !state.config.enabled}
                    onClick={() =>
                      void run(async () => open(await api.previewReconcile()))
                    }
                  >
                    Предпросмотр сверки — 25 заказов
                  </Button>
                  <Typography.Text type="secondary">
                    Только выбранные заказы подключаются к передаче стадий.
                    Новые заказы и изменения статуса поступают автоматически
                    после включения.
                  </Typography.Text>
                  <Space.Compact>
                    <Input
                      aria-label="ID заказа для повтора передачи стадии"
                      placeholder="ID заказа ERP"
                      value={retryId}
                      onChange={(e) =>
                        setRetryId(e.target.value.replace(/\D/g, ''))
                      }
                    />
                    <Button
                      disabled={busy || !retryId || !state.config.enabled}
                      onClick={() =>
                        void run(async () => {
                          await api.retry(retryId);
                          accept(await api.state());
                        })
                      }
                    >
                      Повторить стадию
                    </Button>
                  </Space.Compact>
                  <Typography.Text type="secondary">
                    Повтор — после устранения причины в журнале Bitrix → Очередь
                    → Стадии заказов.
                  </Typography.Text>
                </>
              )
            )}
          </Space>
        </Collapse.Panel>
      </Collapse>
      <Modal
        open={Boolean(job)}
        width={900}
        title={
          job?.kind === 'settings'
            ? 'Подтвердить настройки стадий'
            : job?.kind === 'provision'
            ? 'Создать рабочие стадии'
            : 'Сверка стадий существующих сделок'
        }
        onCancel={() => {
          if (!busy) setJob(null);
        }}
        footer={null}
      >
        {job && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {error && <Alert type="error" showIcon message={error} />}
            <Typography.Text type="secondary">
              Операция {job.job_id}. Предпросмотр действителен до{' '}
              {new Date(job.expires_at).toLocaleString('ru-RU')}.
            </Typography.Text>
            {job.kind === 'settings' && (
              <>
                <Typography.Paragraph>
                  Передача: {state?.config.enabled ? 'включена' : 'выключена'} →{' '}
                  {job.payload.settings?.enabled ? 'включена' : 'выключена'}.
                  Уже подключённых заказов затронуто:{' '}
                  {job.payload.affectedOrderIds?.length ?? 0}. Старые
                  неподключённые сделки не затрагиваются.
                </Typography.Paragraph>
                {!job.payload.settings?.enabled && (
                  <Alert
                    type="warning"
                    message="Отключение отменяет очередь стадий"
                    description="При отключении сохраняются текущие сопоставления; другие правки формы не применяются. Отменённые задания не возобновятся при включении. Используйте отдельную сверку."
                  />
                )}
                <Table
                  size="small"
                  pagination={false}
                  rowKey="orderStatusId"
                  dataSource={job.payload.settings?.mappings ?? []}
                  columns={[
                    {
                      title: 'Статус ERP',
                      render: (_, r) =>
                        state?.statuses.find((s) => s.id === r.orderStatusId)
                          ?.name ?? r.orderStatusId,
                    },
                    {
                      title: 'Было',
                      render: (_, r) =>
                        state?.mappings.find(
                          (m) => m.order_status_id === r.orderStatusId
                        )?.stage_id ?? 'Не сопоставлен',
                    },
                    { title: 'Будет', dataIndex: 'stageId' },
                  ]}
                />
              </>
            )}
            {job.kind === 'provision' && (
              <Table
                size="small"
                pagination={false}
                rowKey="statusId"
                dataSource={job.payload.rows ?? []}
                columns={[
                  { title: 'Название', dataIndex: 'name' },
                  { title: 'Код', dataIndex: 'id' },
                  { title: 'Порядок', dataIndex: 'sort' },
                  {
                    title: 'Результат',
                    render: (_, r) =>
                      job.results[String(r.statusId)] ?? 'Не создана',
                  },
                ]}
              />
            )}
            {job.kind === 'reconcile' && (
              <Table
                size="small"
                pagination={false}
                rowKey="orderId"
                dataSource={job.payload.rows ?? []}
                scroll={{ x: 700 }}
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: setSelected,
                  getCheckboxProps: (r) => ({
                    disabled: Boolean(r.error || job.results[r.orderId]),
                  }),
                }}
                columns={[
                  {
                    title: 'Заказ ERP',
                    render: (_, r) => `№${r.orderName} (ID ${r.orderId})`,
                  },
                  { title: 'Сделка', dataIndex: 'bitrixId' },
                  { title: 'Сейчас', dataIndex: 'oldName' },
                  { title: 'По ERP', dataIndex: 'newName' },
                  {
                    title: 'Результат',
                    render: (_, r) =>
                      r.error ||
                      job.results[r.orderId] ||
                      (r.change
                        ? 'Будет изменена'
                        : 'Совпадает; подключить контроль'),
                  },
                ]}
              />
            )}
            {job.kind !== 'reconcile' && (
              <Checkbox
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              >
                Проверены роботы, триггеры и обязательные поля стадий Bitrix.
                Последствия изменения стадий понятны.
              </Checkbox>
            )}
            <Space wrap>
              <Button
                type="primary"
                loading={busy}
                disabled={
                  job.kind === 'reconcile' ? !selected.length : !reviewed
                }
                onClick={() => void apply()}
              >
                {job.kind === 'reconcile'
                  ? `Подключить выбранные (${selected.length})`
                  : 'Подтвердить'}
              </Button>
              {job.kind !== 'settings' && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => setJob(await api.job(job.job_id)))
                  }
                >
                  Обновить результаты
                </Button>
              )}
              {job.kind === 'reconcile' && job.payload.hasMore && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      open(
                        await api.previewReconcile(
                          Number(job.payload.nextCursor)
                        )
                      )
                    )
                  }
                >
                  Следующие 25 заказов
                </Button>
              )}
            </Space>
          </Space>
        )}
      </Modal>
    </>
  );
}
