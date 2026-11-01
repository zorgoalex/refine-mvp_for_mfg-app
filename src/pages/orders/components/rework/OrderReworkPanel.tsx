import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Modal, Space, Tag, Typography, message } from 'antd';
import { Table, Tooltip } from '../../../../ui/tooltipDelay';
import {
  orderReworkApi,
  REWORK_CLOSE_REASON_LABELS,
  type OrderReworkAvailability,
  type OrderReworkReason,
  type OrderReworkRound,
  type OrderReworkState,
} from '../../../../api/orderReworkApi';
import { can } from '../../../../utils/permissions';
import { useIsMobile } from '../../../../hooks/useDeviceTier';
import {
  createLatestGate,
  reworkFormVersion,
  reworkActionLabel,
  type ReworkDetailRow,
  type ReworkStageOption,
} from './orderReworkModel';
import { formatReworkDate, ReasonFields, ReworkStartModal } from './ReworkStartModal';

const { Text } = Typography;

export interface OrderReworkPanelProps {
  orderId: number;
  version: number;
  details: ReworkDetailRow[];
  stages: ReworkStageOption[];
  /** Called after any successful command so the card re-reads the order. */
  onChanged: () => void;
  /**
   * The start/extend command lives in the card's «⋯» menu: the panel reports what the menu item is (null — none for
   * this user/order) and opens its form each time `startRequest` changes.
   */
  onStartActionChange?: (action: ReworkStartMenuAction | null) => void;
  startRequest?: number;
}

export interface ReworkStartMenuAction {
  label: string;
  disabled: boolean;
  /** Why the item is disabled (MDF engine, cutover, data re-loading). */
  hint: string | null;
}

const UNAVAILABLE_HINT: Record<Exclude<OrderReworkAvailability, 'available' | 'disabled_flag'>, string> = {
  mdf_engine_unsupported: 'Переделка станет доступна после поддержки кругов в МДФ-движке',
  mdf_cutover_in_progress: 'Идёт переключение производственного учёта, повторите позже',
};

/** The «⋯» menu item for starting/extending a round — same gates as the panel used for its button. */
function startMenuAction(
  state: OrderReworkState | null,
  availability: OrderReworkAvailability | null,
  cardVersion: number,
): ReworkStartMenuAction | null {
  if (!state || !availability || availability === 'disabled_flag') return null;
  const { order } = state;
  if (!order.canRework || order.action === null) return null;
  const unavailableHint = availability !== 'available' ? UNAVAILABLE_HINT[availability] : null;
  const syncing = reworkFormVersion(order.version, cardVersion) === null;
  return {
    label: reworkActionLabel(order.action, order.openRoundNo),
    disabled: Boolean(unavailableHint) || syncing,
    hint: unavailableHint ?? (syncing ? 'Данные заказа обновляются…' : null),
  };
}

const errorText = (error: unknown) =>
  (error as { message?: string } | null)?.message ?? 'Не удалось выполнить действие';

/**
 * «Переделка» in the order card (plan §9): start/extend buttons, the open-round banner
 * (clarify reason, «Это не переделка») and the round history.
 */
export const OrderReworkPanel: React.FC<OrderReworkPanelProps> = ({
  orderId, version, details, stages, onChanged, onStartActionChange, startRequest,
}) => {
  // Reasons are loaded for holders of the permission; actions use the backend-resolved capability.
  const canLoadReasons = can('orders.rework');
  // On a phone the round actions go under the banner text (as an Alert action they squeeze it into a column).
  const isMobile = useIsMobile();
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

  // The «⋯» menu item of the card (reported up) and its open requests — before any early return (hooks).
  const startMenu = startMenuAction(state, availability, version);
  const startMenuKey = JSON.stringify(startMenu);
  useEffect(() => { onStartActionChange?.(startMenu); }, [startMenuKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onStartActionChange?.(null), [onStartActionChange]);
  const handledStartRequest = useRef(startRequest);
  useEffect(() => {
    if (startRequest === undefined || startRequest === handledStartRequest.current) return;
    handledStartRequest.current = startRequest;
    const formVersionNow = state ? reworkFormVersion(state.order.version, version) : null;
    if (startMenu && !startMenu.disabled && formVersionNow !== null) setStartForm({ version: formVersionNow });
  }, [startRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state || availability === 'disabled_flag' && state.data.length === 0) return null;
  const { order } = state;
  // Same gates as the backend commands: orders.rework + orders.update within the order's update scope; with the flag
  // off every command answers 503, so the history stays readable without actions.
  const canRework = order.canRework && availability !== 'disabled_flag';
  const openRound = state.data.find((round) => round.closedAt === null) ?? null;
  // Forms send the version the shown rounds were read with; while it differs from the card
  // (data stale or re-loading) actions are disabled.
  const formVersion = reworkFormVersion(order.version, version);
  const syncing = formVersion === null;
  const action = order.action;
  const unavailableHint = availability && availability !== 'available' && availability !== 'disabled_flag'
    ? UNAVAILABLE_HINT[availability] : null;
  const showStart = canRework && action !== null;

  const roundActions = (round: OrderReworkRound) => (
    <Space wrap>
      <Button size="small" disabled={syncing} onClick={() => formVersion !== null && setReasonForm({ round, version: formVersion })}>
        {round.reasonIsSystem ? 'Указать причину' : 'Изменить причину'}
      </Button>
      <Button size="small" danger disabled={syncing} onClick={falsePositive}>Это не переделка</Button>
    </Space>
  );

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
                {openRound.plannedCompletionDate ? `, срок: ${formatReworkDate(openRound.plannedCompletionDate)}` : ''}
              </Text>
            </Space>
          )}
          action={canRework && !isMobile ? roundActions(openRound) : undefined}
          description={canRework && isMobile ? roundActions(openRound) : undefined}
        />
      ) : null}
      {/* The command itself is in the card's «⋯» menu; why it is unavailable is written here. */}
      {showStart && unavailableHint ? (
        <Space style={{ marginTop: openRound ? 6 : 0 }}>
          <Text type="secondary">{reworkActionLabel(action!, order.openRoundNo)}: {unavailableHint}</Text>
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
                // Narrow columns (NewLine card, phone): the history scrolls inside its block instead of overflowing.
                scroll={{ x: 'max-content' }}
                dataSource={state.data}
                columns={[
                  { title: 'Круг', dataIndex: 'roundNo', width: 60, render: (n: number) => `·${n}` },
                  { title: 'Причина', render: (_: unknown, r) => `${r.reasonName}${r.reasonComment ? ` — ${r.reasonComment}` : ''}` },
                  { title: 'Источник', dataIndex: 'source', width: 120, render: (s: string) => (s === 'manual' ? 'вручную' : s === 'import' ? 'импорт' : 'авто по раскрою') },
                  { title: 'Начат', width: 170, render: (_: unknown, r) => `${new Date(r.startedAt).toLocaleString('ru-RU')}${r.startedByUsername ? `, ${r.startedByUsername}` : ''}` },
                  { title: 'Деталей', width: 80, render: (_: unknown, r) => r.details.length },
                  {
                    title: 'Срок', width: 110,
                    render: (_: unknown, r: OrderReworkRound) => (r.plannedCompletionDate ? (
                      <Tooltip title={r.fromPlannedCompletionDate ? `Было: ${formatReworkDate(r.fromPlannedCompletionDate)}` : undefined}>
                        <span>{formatReworkDate(r.plannedCompletionDate)}</span>
                      </Tooltip>
                    ) : '—'),
                  },
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
          roundNo={order.openRoundNo ?? order.lastRoundNo + 1}
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
