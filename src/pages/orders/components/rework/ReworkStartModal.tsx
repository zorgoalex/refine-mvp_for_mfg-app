import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, DatePicker, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { Table } from '../../../../ui/tooltipDelay';
import {
  orderReworkApi,
  withRoundSuffix,
  type OrderReworkDeadlineSuggestion,
  type OrderReworkReason,
} from '../../../../api/orderReworkApi';
import {
  buildReworkRequest,
  createLatestGate,
  isRedoFromAllowed,
  redoGroups,
  redoSummary,
  redoTarget,
  reworkActionLabel,
  reworkChain,
  type RedoSummary,
  type ReworkDetailRow,
  type ReworkStageOption,
} from './orderReworkModel';

const { Text } = Typography;

/** «Переделка» 1.1: YYYY-MM-DD → ДД.ММ.ГГГГ. */
export function formatReworkDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

export const ReasonFields: React.FC<{
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


/**
 * «Что переделать?»: the stages as a chain; the user clicks the first stage to do again. Before it — done (kept), from
 * it on — to redo. Below — the outcome in words.
 */
const RedoChain: React.FC<{
  chain: ReworkStageOption[];
  redoFrom: number | undefined;
  onPick: (stageId: number) => void;
  /** One outcome per group of details with the same «redo from» (the label lists them when there is more than one). */
  outcomes: Array<{ label: string; summary: RedoSummary }>;
  roundNo: number;
}> = ({ chain, redoFrom, onPick, outcomes, roundNo }) => {
  const picked = chain.find((stage) => stage.id === redoFrom);
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Text strong>Что переделать? <Text type="secondary" style={{ fontWeight: 'normal' }}>Нажмите первый этап, который нужно сделать заново</Text></Text>
      <Space wrap size={[2, 6]} role="radiogroup" aria-label="Первый этап, который нужно сделать заново">
        {chain.map((stage, index) => {
          const state = !picked ? 'idle' : stage.sortOrder < picked.sortOrder ? 'kept' : 'redo';
          return (
            <React.Fragment key={stage.id}>
              {index > 0 ? <Text type="secondary">→</Text> : null}
              <Tag
                role="radio"
                aria-checked={stage.id === redoFrom}
                tabIndex={0}
                color={state === 'kept' ? 'success' : state === 'redo' ? 'warning' : undefined}
                style={{ cursor: 'pointer', marginInlineEnd: 0, fontWeight: stage.id === redoFrom ? 600 : undefined }}
                onClick={() => onPick(stage.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(stage.id); } }}
              >
                {state === 'kept' ? '✓ ' : state === 'redo' ? '⟳ ' : ''}{stage.name}
              </Tag>
            </React.Fragment>
          );
        })}
      </Space>
      {outcomes.map(({ label, summary }) => (
        <Text type="secondary" key={label}>
          {outcomes.length > 1 ? <Text strong>{label}: </Text> : null}
          {summary.kept.length > 0 ? `Остаётся сделанным: ${summary.kept.join(', ')}. ` : 'Всё делается заново. '}
          {summary.redo.length > 0 ? `Переделать: ${summary.redo.join(', ')}. ` : ''}
          {`Станут «${withRoundSuffix(summary.becomes ?? '', roundNo)}», следующий этап — ${summary.next}.`}
        </Text>
      ))}
    </Space>
  );
};

export const ReworkStartModal: React.FC<{
  orderId: number;
  version: number;
  action: 'return' | 'start_in_production' | 'extend';
  openRoundNo: number | null;
  /** The round the details go to (the open one, or the next number) — for «станет «Распилен ·N»». */
  roundNo: number;
  details: ReworkDetailRow[];
  stages: ReworkStageOption[];
  reasons: OrderReworkReason[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onDone: (text: string) => Promise<void>;
  onFailed: (error: unknown) => Promise<void>;
}> = ({ orderId, version, action, openRoundNo, roundNo, details, stages, reasons, busy, setBusy, onCancel, onDone, onFailed }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // «What to redo»: the first stage to do again (for all selected details, or per detail). The backend takes the stage
  // before it — the one the detail returns to and that stays done.
  const [commonRedo, setCommonRedo] = useState<number | undefined>();
  const [perRowRedo, setPerRowRedo] = useState<Record<number, number | undefined>>({});
  const commonStage = redoTarget(commonRedo, stages);
  const perRow = useMemo(() => {
    const targets: Record<number, number | undefined> = {};
    for (const [detailId, redoFrom] of Object.entries(perRowRedo)) targets[Number(detailId)] = redoTarget(redoFrom, stages);
    return targets;
  }, [perRowRedo, stages]);
  const chain = useMemo(() => reworkChain(stages), [stages]);
  const [reasonId, setReasonId] = useState<number | undefined>();
  const [comment, setComment] = useState('');
  // «Переделка» 1.1: the round deadline — pre-filled from «Схема этапов и сроки» until edited by hand.
  const [plannedDate, setPlannedDate] = useState<string | null>(null);
  const [plannedDateTouched, setPlannedDateTouched] = useState(false);
  const [suggestion, setSuggestion] = useState<OrderReworkDeadlineSuggestion | null>(null);
  const suggestionGate = useRef(createLatestGate());
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const eligible = details.filter((d) => d.productionStatusId != null);
  const needsReason = action !== 'extend';
  const deadlineRequired = action === 'return';
  const request = buildReworkRequest({
    selected, commonStage, perRow, details, stageById, reasonId, comment, needsReason, reasons,
    plannedCompletionDate: plannedDate, deadlineRequired,
  });
  const targetsKey = JSON.stringify(details
    .filter((d) => selected.has(d.id))
    .map((d) => [d.id, perRow[d.id] ?? commonStage ?? null]));
  useEffect(() => {
    const targets = (JSON.parse(targetsKey) as Array<[number, number | null]>)
      .filter((pair): pair is [number, number] => pair[1] !== null)
      .map(([detailId, productionStatusId]) => ({ detailId, productionStatusId }));
    if (targets.length === 0) { setSuggestion(null); return undefined; }
    const ticket = suggestionGate.current.begin();
    const timer = window.setTimeout(() => {
      void orderReworkApi.suggestDeadline(orderId, targets).then((next) => {
        if (!suggestionGate.current.isLatest(ticket)) return;
        setSuggestion(next);
        if (!plannedDateTouched) {
          const current = next.roundPlannedCompletionDate;
          // Adding details moves the round deadline only later; starting a round takes the suggestion.
          const prefill = action === 'extend'
            ? (next.suggestedDate && (!current || next.suggestedDate > current) ? next.suggestedDate : null)
            : next.suggestedDate;
          setPlannedDate(prefill);
        }
      }).catch(() => {
        if (suggestionGate.current.isLatest(ticket)) setSuggestion(null);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [targetsKey, orderId, action, plannedDateTouched]);
  const deadlineHint = !suggestion ? (deadlineRequired ? 'Выберите детали и этапы — срок рассчитается по «Схеме этапов и сроки»' : null)
    : suggestion.suggestedDate
      ? `По «Схеме этапов и сроки»: ${suggestion.plannedOrderDays} дн. — ${formatReworkDate(suggestion.suggestedDate)}`
      : suggestion.scheduleConfigured
        ? 'Этапы вне схемы сроков — укажите срок вручную'
        : 'Схема этапов и сроки не заполнена — укажите срок вручную';
  const roundDeadlineNote = action === 'extend' && suggestion?.roundPlannedCompletionDate
    ? `Текущий срок круга: ${formatReworkDate(suggestion.roundPlannedCompletionDate)} — при добавлении деталей срок только сдвигается позже.`
    : null;
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
        <RedoChain
          chain={chain}
          redoFrom={commonRedo}
          onPick={setCommonRedo}
          outcomes={redoGroups(selected.size > 0 ? eligible.filter((d) => selected.has(d.id)) : eligible, perRowRedo, commonRedo)
            .map((group) => ({
              label: group.details.map((d) => `№${d.detailNumber ?? d.id}`).join(', '),
              summary: redoSummary(group.redoFrom, stages, group.details.map((d) => d.productionStatusId)),
            }))
            .filter((outcome): outcome is { label: string; summary: RedoSummary } => outcome.summary !== null)}
          roundNo={roundNo}
        />
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
              title: 'Переделать с', width: 200,
              render: (_: unknown, d: ReworkDetailRow) => {
                const current = stageById.get(d.productionStatusId!);
                const redoFrom = perRowRedo[d.id] ?? commonRedo;
                const notReached = selected.has(d.id) && redoFrom !== undefined && !isRedoFromAllowed(redoFrom, current, stages);
                return (
                  <Space direction="vertical" size={0} style={{ width: '100%' }}>
                    <Select
                      size="small"
                      style={{ width: '100%' }}
                      allowClear
                      status={notReached ? 'error' : undefined}
                      placeholder={commonRedo ? stageById.get(commonRedo)?.name : 'как у всех'}
                      value={perRowRedo[d.id]}
                      onChange={(value) => setPerRowRedo({ ...perRowRedo, [d.id]: value })}
                      options={chain
                        .filter((stage) => isRedoFromAllowed(stage.id, current, stages))
                        .map((stage) => ({ value: stage.id, label: stage.name }))}
                    />
                    {notReached ? <Text type="danger" style={{ fontSize: 12 }}>этот этап деталь ещё не проходила</Text> : null}
                  </Space>
                );
              },
            },
          ]}
        />
        <Form layout="vertical">
          <Form.Item
            label="Срок готовности"
            required={deadlineRequired}
            extra={[deadlineHint, roundDeadlineNote].filter(Boolean).join(' ') || undefined}
            style={{ marginBottom: 4 }}
          >
            <DatePicker
              format="DD.MM.YYYY"
              allowClear={!deadlineRequired}
              value={plannedDate ? dayjs(plannedDate) : null}
              disabledDate={(day) => Boolean(suggestion?.today) && day.format('YYYY-MM-DD') < (suggestion?.today ?? '')}
              onChange={(day) => { setPlannedDateTouched(true); setPlannedDate(day ? day.format('YYYY-MM-DD') : null); }}
            />
          </Form.Item>
        </Form>
        {needsReason ? (
          <ReasonFields reasons={reasons} reasonId={reasonId} setReasonId={setReasonId} comment={comment} setComment={setComment} />
        ) : null}
        {hint ? <Text type="secondary">{hint}</Text> : null}
      </Space>
    </Modal>
  );
};
