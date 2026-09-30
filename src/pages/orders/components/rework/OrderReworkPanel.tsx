import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import {
  orderReworkApi,
  REWORK_CLOSE_REASON_LABELS,
  type OrderReworkAvailability,
  type OrderReworkReason,
  type OrderReworkRound,
  type OrderReworkState,
} from '../../../../api/orderReworkApi';
import { can } from '../../../../utils/permissions';
import {
  buildReworkRequest,
  createLatestGate,
  isReworkTargetAllowed,
  reworkFormVersion,
  reworkActionLabel,
  type ReworkDetailRow,
  type ReworkStageOption,
} from './orderReworkModel';

const { Text } = Typography;

export interface OrderReworkPanelProps {
  orderId: number;
  version: number;
  details: ReworkDetailRow[];
  stages: ReworkStageOption[];
  /** Called after any successful command so the card re-reads the order. */
  onChanged: () => void;
}

const UNAVAILABLE_HINT: Record<Exclude<OrderReworkAvailability, 'available' | 'disabled_flag'>, string> = {
  mdf_engine_unsupported: 'Переделка станет доступна после поддержки кругов в МДФ-движке',
  mdf_cutover_in_progress: 'Идёт переключение производственного учёта, повторите позже',
};

const errorText = (error: unknown) =>
  (error as { message?: string } | null)?.message ?? 'Не удалось выполнить действие';

/**
 * «Переделка» in the order card (plan §9): start/extend buttons, the open-round banner
 * (clarify reason, «Это не переделка») and the round history.
 */
export const OrderReworkPanel: React.FC<OrderReworkPanelProps> = ({ orderId, version, details, stages, onChanged }) => {
  // Reasons are loaded for holders of the permission; actions use the backend-resolved capability.
  const canLoadReasons = can('orders.rework');
  const [state, setState] = useState<OrderReworkState | null>(null);
  const [availability, setAvailability] = useState<OrderReworkAvailability | null>(null);
  const [reasons, setReasons] = useState<OrderReworkReason[]>([]);
  /**
   * Open forms keep the order version they were opened with (If-Match): a background re-read
   * must not turn an edit made on stale data into a silent overwrite — the backend answers 409.
   */
  const [startForm, setStartForm] = useState<{ version: number } | null>(null);
  /** Round whose reason is being set — the open one or a closed one from the history (plan §8.5). */
  const [reasonForm, setReasonForm] = useState<{ round: OrderReworkRound; version: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const gate = useRef(createLatestGate()).current;
  const reload = useCallback(async () => {
    const ticket = gate.begin();
    try {
      const [rounds, avail] = await Promise.all([orderReworkApi.rounds(orderId), orderReworkApi.availability()]);
      if (!gate.isLatest(ticket)) return; // a newer load is in flight — drop this stale response
      setState(rounds);
      setAvailability(avail.availability);
    } catch {
      if (gate.isLatest(ticket)) setState(null);
    }
  }, [gate, orderId]);

  useEffect(() => { void reload(); }, [reload, version]);
  // Rounds read at a newer order version than the card shows (someone changed the order):
  // re-read the card once per version so the pair becomes consistent again.
  const cardRefreshRequested = useRef<number | null>(null);
  const roundsVersion = state?.order.version ?? null;
  useEffect(() => {
    if (roundsVersion === null || roundsVersion <= version || cardRefreshRequested.current === roundsVersion) return;
    cardRefreshRequested.current = roundsVersion;
    onChanged();
  }, [onChanged, roundsVersion, version]);
  useEffect(() => {
    if (!canLoadReasons) return;
    orderReworkApi.reasons().then((r) => setReasons(r.data)).catch(() => setReasons([]));
  }, [canLoadReasons]);

  /** 409 (order changed meanwhile): close the form and re-read so the user edits current data. */
  const failed = useCallback(async (error: unknown) => {
    if ((error as { status?: number; statusCode?: number } | null)?.status === 409
      || (error as { statusCode?: number } | null)?.statusCode === 409) {
      message.warning(`${errorText(error)}. Данные обновлены — повторите действие.`);
      setStartForm(null);
      setReasonForm(null);
      await reload();
      onChanged();
      return;
    }
    message.error(errorText(error));
  }, [onChanged, reload]);

  const done = useCallback(async (text: string) => {
    message.success(text);
    setStartForm(null);
    setReasonForm(null);
    await reload();
    onChanged();
  }, [onChanged, reload]);

  if (!state || availability === 'disabled_flag' && state.data.length === 0) return null;
  const { order } = state;
  // Same gates as the backend commands: orders.rework + orders.update within the order's update scope.
  const canRework = order.canRework;
  const openRound = state.data.find((round) => round.closedAt === null) ?? null;
  // Forms send the version the shown rounds were read with; while it differs from the card
  // (data stale or re-loading) actions are disabled.
  const formVersion = reworkFormVersion(order.version, version);
  const syncing = formVersion === null;
  const action = order.action;
  const unavailableHint = availability && availability !== 'available' && availability !== 'disabled_flag'
    ? UNAVAILABLE_HINT[availability] : null;
  const showStart = canRework && action !== null && availability !== 'disabled_flag';

  const falsePositive = () => {
    if (!openRound) return;
    if (formVersion === null) return;
    const openedVersion = formVersion;
    Modal.confirm({
      title: `Это не переделка (круг ·${openRound.roundNo})?`,
      content: 'Детали круга вернутся на прежние этапы и в прежний круг; для «Вернуть в переделку» вернётся и прежний статус заказа.',
      okText: 'Отменить круг',
      cancelText: 'Назад',
      onOk: async () => {
        try {
          await orderReworkApi.falsePositive(orderId, openRound.roundNo, openedVersion);
          await done('Круг отменён');
        } catch (error) {
          await failed(error);
        }
      },
    });
  };

  return (
    <div className="order-rework-panel" style={{ marginBottom: 8 }}>
      {openRound ? (
        <Alert
          type={openRound.reasonIsSystem ? 'warning' : 'info'}
          showIcon
          message={(
            <Space wrap>
              <Text strong>Переделка ·{openRound.roundNo}:</Text>
              <Text>{openRound.reasonName}{openRound.reasonComment ? ` — ${openRound.reasonComment}` : ''}</Text>
              <Text type="secondary">
                {openRound.mode === 'after_ready' ? 'после готовности' : 'в производстве'}, деталей: {openRound.details.length}
              </Text>
            </Space>
          )}
          action={canRework ? (
            <Space>
              <Button size="small" disabled={syncing} onClick={() => formVersion !== null && setReasonForm({ round: openRound, version: formVersion })}>
                {openRound.reasonIsSystem ? 'Указать причину' : 'Изменить причину'}
              </Button>
              <Button size="small" danger disabled={syncing} onClick={falsePositive}>Это не переделка</Button>
            </Space>
          ) : undefined}
        />
      ) : null}
      {showStart ? (
        <Space style={{ marginTop: openRound ? 6 : 0 }}>
          <Tooltip title={unavailableHint ?? (action === 'start_in_production' ? 'Брак — выбранные детали пойдут повторно' : undefined)}>
            <Button
              size="small"
              disabled={Boolean(unavailableHint) || syncing}
              onClick={() => formVersion !== null && setStartForm({ version: formVersion })}
            >
              {reworkActionLabel(action!, order.openRoundNo)}
            </Button>
          </Tooltip>
        </Space>
      ) : null}
      {syncing ? (
        <Space style={{ marginTop: 4 }}>
          <Text type="secondary">Данные заказа обновляются…</Text>
          <Button size="small" type="link" onClick={() => { cardRefreshRequested.current = null; void reload(); onChanged(); }}>
            Обновить
          </Button>
        </Space>
      ) : null}
      {state.data.length > 0 ? (
        <Collapse ghost>
          <Collapse.Panel key="history" header={`История переделок (${state.data.length})`}>
              <Table
                size="small"
                rowKey="roundNo"
                pagination={false}
                dataSource={state.data}
                columns={[
                  { title: 'Круг', dataIndex: 'roundNo', width: 60, render: (n: number) => `·${n}` },
                  { title: 'Причина', render: (_: unknown, r) => `${r.reasonName}${r.reasonComment ? ` — ${r.reasonComment}` : ''}` },
                  { title: 'Источник', dataIndex: 'source', width: 120, render: (s: string) => (s === 'manual' ? 'вручную' : s === 'import' ? 'импорт' : 'авто по раскрою') },
                  { title: 'Начат', width: 170, render: (_: unknown, r) => `${new Date(r.startedAt).toLocaleString('ru-RU')}${r.startedByUsername ? `, ${r.startedByUsername}` : ''}` },
                  { title: 'Деталей', width: 80, render: (_: unknown, r) => r.details.length },
                  {
                    title: 'Закрыт', width: 170,
                    render: (_: unknown, r) => (r.closedAt
                      ? <Tag>{REWORK_CLOSE_REASON_LABELS[r.closeReason!]}</Tag>
                      : <Tag color="orange">открыт</Tag>),
                  },
                  ...(canRework ? [{
                    title: '', width: 150,
                    render: (_: unknown, r: OrderReworkRound) => (
                      <Button size="small" type="link" disabled={syncing} onClick={() => formVersion !== null && setReasonForm({ round: r, version: formVersion })}>
                        {r.reasonIsSystem ? 'Указать причину' : 'Изменить причину'}
                      </Button>
                    ),
                  }] : []),
                ]}
              />
          </Collapse.Panel>
        </Collapse>
      ) : null}
      {startForm && action ? (
        <ReworkStartModal
          orderId={orderId}
          version={startForm.version}
          action={action}
          openRoundNo={order.openRoundNo}
          details={details}
          stages={stages}
          reasons={reasons}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => setStartForm(null)}
          onDone={done}
          onFailed={failed}
        />
      ) : null}
      {reasonForm ? (
        <ReworkReasonModal
          title={`Причина переделки ·${reasonForm.round.roundNo}`}
          reasons={reasons}
          initialReasonId={reasonForm.round.reasonIsSystem ? undefined : reasonForm.round.reasonId}
          initialComment={reasonForm.round.reasonComment}
          busy={busy}
          onCancel={() => setReasonForm(null)}
          onSubmit={async (reasonId, comment) => {
            setBusy(true);
            try {
              await orderReworkApi.clarifyReason(orderId, reasonForm.round.roundNo, reasonForm.version, { reasonId, comment });
              await done('Причина сохранена');
            } catch (error) {
              await failed(error);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
};

const ReworkReasonModal: React.FC<{
  title: string;
  reasons: OrderReworkReason[];
  initialReasonId?: number;
  initialComment?: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reasonId: number, comment: string | null) => void;
}> = ({ title, reasons, initialReasonId, initialComment, busy, onCancel, onSubmit }) => {
  const [reasonId, setReasonId] = useState<number | undefined>(initialReasonId);
  const [comment, setComment] = useState(initialComment ?? '');
  const reason = reasons.find((r) => r.reasonId === reasonId);
  const commentMissing = Boolean(reason?.requiresComment) && comment.trim() === '';
  return (
    <Modal
      open
      title={title}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={busy}
      okButtonProps={{ disabled: !reasonId || commentMissing }}
      onCancel={onCancel}
      onOk={() => reasonId && onSubmit(reasonId, comment.trim() || null)}
    >
      <ReasonFields reasons={reasons} reasonId={reasonId} setReasonId={setReasonId} comment={comment} setComment={setComment} />
    </Modal>
  );
};

const ReasonFields: React.FC<{
  reasons: OrderReworkReason[];
  reasonId: number | undefined;
  setReasonId: (id: number) => void;
  comment: string;
  setComment: (value: string) => void;
}> = ({ reasons, reasonId, setReasonId, comment, setComment }) => {
  const reason = reasons.find((r) => r.reasonId === reasonId);
  return (
    <Form layout="vertical">
      <Form.Item label="Причина" required>
        <Select
          value={reasonId}
          onChange={setReasonId}
          placeholder="Выберите причину"
          options={reasons.map((r) => ({ value: r.reasonId, label: r.name }))}
        />
      </Form.Item>
      <Form.Item label={reason?.requiresComment ? 'Комментарий (обязателен)' : 'Комментарий'} required={reason?.requiresComment}>
        <Input.TextArea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} autoSize={{ minRows: 2, maxRows: 5 }} />
      </Form.Item>
    </Form>
  );
};

const ReworkStartModal: React.FC<{
  orderId: number;
  version: number;
  action: 'return' | 'start_in_production' | 'extend';
  openRoundNo: number | null;
  details: ReworkDetailRow[];
  stages: ReworkStageOption[];
  reasons: OrderReworkReason[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (text: string) => Promise<void>;
  onFailed: (error: unknown) => Promise<void>;
}> = ({ orderId, version, action, openRoundNo, details, stages, reasons, busy, setBusy, onCancel, onDone, onFailed }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [commonStage, setCommonStage] = useState<number | undefined>();
  const [perRow, setPerRow] = useState<Record<number, number | undefined>>({});
  const [reasonId, setReasonId] = useState<number | undefined>();
  const [comment, setComment] = useState('');
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const needsReason = action !== 'extend';
  const request = buildReworkRequest({ selected, commonStage, perRow, details, stageById, reasonId, comment, needsReason, reasons });
  const hint = 'message' in request ? request.message : null;

  const submit = async () => {
    if (!request.ok) return;
    setBusy(true);
    try {
      const result = await orderReworkApi.startOrExtend(orderId, version, request.body);
      await onDone(result.action === 'extended' ? 'Детали добавлены в переделку' : `Переделка ·${result.roundNo} начата`);
    } catch (error) {
      await onFailed(error);
    } finally {
      setBusy(false);
    }
  };

  const eligible = details.filter((d) => d.productionStatusId != null);
  return (
    <Modal
      open
      width={820}
      title={reworkActionLabel(action, openRoundNo)}
      okText={action === 'extend' ? 'Добавить' : 'Начать переделку'}
      cancelText="Отмена"
      confirmLoading={busy}
      okButtonProps={{ disabled: !request.ok }}
      onCancel={onCancel}
      onOk={() => void submit()}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Text>Вернуть выбранные детали на этап:</Text>
          <Select
            style={{ minWidth: 220 }}
            value={commonStage}
            onChange={setCommonStage}
            placeholder="Этап для всех выбранных"
            options={stages.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Space>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ y: 320 }}
          dataSource={eligible}
          columns={[
            {
              title: (
                <Checkbox
                  checked={eligible.length > 0 && selected.size === eligible.length}
                  indeterminate={selected.size > 0 && selected.size < eligible.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(eligible.map((d) => d.id)) : new Set())}
                />
              ),
              width: 40,
              render: (_: unknown, d: ReworkDetailRow) => (
                <Checkbox
                  checked={selected.has(d.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(d.id); else next.delete(d.id);
                    setSelected(next);
                  }}
                />
              ),
            },
            { title: '№', dataIndex: 'detailNumber', width: 60 },
            { title: 'Деталь', dataIndex: 'name', ellipsis: true },
            {
              title: 'Текущий этап', width: 170,
              render: (_: unknown, d: ReworkDetailRow) => {
                const name = stageById.get(d.productionStatusId!)?.name ?? '—';
                return d.productionRound > 1 ? `${name} ·${d.productionRound}` : name;
              },
            },
            {
              title: 'Вернуть на этап', width: 200,
              render: (_: unknown, d: ReworkDetailRow) => (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  allowClear
                  placeholder={commonStage ? stageById.get(commonStage)?.name : 'как у всех'}
                  value={perRow[d.id]}
                  onChange={(value) => setPerRow({ ...perRow, [d.id]: value })}
                  options={stages
                    .filter((s) => isReworkTargetAllowed(s, stageById.get(d.productionStatusId!), stages))
                    .map((s) => ({ value: s.id, label: s.name }))}
                />
              ),
            },
          ]}
        />
        {needsReason ? (
          <ReasonFields reasons={reasons} reasonId={reasonId} setReasonId={setReasonId} comment={comment} setComment={setComment} />
        ) : null}
        {hint ? <Text type="secondary">{hint}</Text> : null}
      </Space>
    </Modal>
  );
};
