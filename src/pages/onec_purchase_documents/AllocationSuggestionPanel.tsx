import { useGetIdentity } from '@refinedev/core';
import { Alert, Button, Checkbox, InputNumber, Space, Spin, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, isApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import type { AllocationSuggestionCandidate, AllocationSuggestionLine, AllocationSuggestionsResponse } from '../../api/types/onecDocumentsApi.types';
import type { UserIdentity } from '../../types/auth';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { useProcurementPermission } from '../order_resource_requirements/ProcurementParts';
import { RrScreen } from '../procurement_workspace/RrScreen';
import { dueText } from '../procurement_workspace/worklistHelpers';
import { onecUnitLabel } from './onecDocumentsHelpers';
import {
  buildBatchRequest,
  candidateDisplay,
  clearSuggestionDraft,
  computeLineTotals,
  computeOverallSummary,
  getLineDraft,
  lineCapacityDemandEquivalent,
  lineCheckStatus,
  loadSuggestionDraft,
  mapBatchFailures,
  resetLineToProposal,
  saveSuggestionDraft,
  setCandidateChecked,
  setCandidateQuantity,
  type MappedBatchFailure,
  type SuggestionDraftState,
} from './allocationSuggestionModel';

const DEMAND_UNIT_LABEL: Record<'m2' | 'lm', string> = { m2: 'м²', lm: 'пог. м' };

const SKIP_REASON_LABEL: Record<NonNullable<AllocationSuggestionLine['skipReason']>, string> = {
  not_mapped: 'Строка не сопоставлена с материалом ERP — подбор недоступен',
  incompatible_unit: 'Единица строки несовместима с потребностью — распределите вручную из карточки документа',
  fully_allocated: 'Строка прихода полностью распределена',
};

/** Тона мягких тегов мокапа. */
const REASON_TONE: Record<string, string> = { info: 'info', error: 'bad', warning: 'warn', success: 'ok', default: 'none' };
const URGENCY_TONE: Record<string, string> = { overdue: 'bad', critical: 'bad', soon: 'warn', normal: 'none', no_date: 'none' };

export interface AllocationSuggestionPanelProps {
  documentId: number;
  /** Успешное распределение — родитель перечитывает карточку/список. */
  onDone?: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'notfound' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AllocationSuggestionsResponse };

/**
 * «Подобрать заказы» для прихода 1С: предложенные кандидаты по каждой строке,
 * редактируемые количества, групповая отправка. Черновик правок — localStorage
 * (план §5.4); отправка — `allocateBatch`, всё или ничего.
 */
export function AllocationSuggestionPanel({ documentId, onDone }: AllocationSuggestionPanelProps) {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const userId = identity?.id ?? 'anon';
  const { canManage, manageLoading } = useProcurementPermission();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<SuggestionDraftState>({ lines: {} });
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<MappedBatchFailure[] | null>(null);

  /** fresh=true — явный «Подобрать заново» после конфликта: черновик сбрасывается, берутся свежие количества. */
  const load = useCallback((fresh = false) => {
    if (!canManage) return;
    if (fresh) clearSuggestionDraft(userId, documentId);
    setState({ status: 'loading' });
    onecDocumentsApi.allocationSuggestions(documentId)
      .then((response) => {
        setState({ status: 'ready', data: response });
        setDraft(loadSuggestionDraft(userId, documentId, response));
        setConflict(null);
      })
      .catch((error: unknown) => {
        if (isApiError(error, 'PROCUREMENT_DISABLED')) { setState({ status: 'disabled' }); return; }
        if (isApiError(error, 'PERMISSION_DENIED') || isApiError(error, 'AUTH_REQUIRED')) {
          setState({ status: 'error', message: 'Недостаточно прав для подбора заказов.' });
          return;
        }
        if (error instanceof ApiError && error.status === 404) { setState({ status: 'notfound' }); return; }
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить предложения' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, canManage, userId]);

  useEffect(() => { load(); }, [load]);
  const reloadFresh = useCallback(() => load(true), [load]);

  // Автосохранение черновика — каждое изменение галочки/количества.
  useEffect(() => {
    if (state.status !== 'ready') return;
    saveSuggestionDraft(userId, documentId, draft);
  }, [draft, documentId, userId, state.status]);

  const response = state.status === 'ready' ? state.data : null;
  const summary = useMemo(() => (response ? computeOverallSummary(response, draft) : null), [response, draft]);

  const toggleCandidate = (lineId: number, orderId: number, checked: boolean) =>
    setDraft((current) => setCandidateChecked(current, lineId, orderId, checked));
  const changeQuantity = (lineId: number, orderId: number, quantity: number) =>
    setDraft((current) => setCandidateQuantity(current, lineId, orderId, quantity));
  const resuggestLine = (line: AllocationSuggestionLine) =>
    setDraft((current) => resetLineToProposal(current, line));

  const handleSubmit = async () => {
    if (!response || !canManage) return;
    const requestId = crypto.randomUUID();
    const built = buildBatchRequest(response, draft, requestId);
    if (!built.request) { message.warning(built.error ?? 'Нечего распределять'); return; }
    setSubmitting(true);
    setConflict(null);
    try {
      const result = await onecDocumentsApi.allocateBatch(documentId, built.request);
      if (result.changed) message.success('Распределено');
      else message.info('Изменений нет — распределение уже такое');
      clearSuggestionDraft(userId, documentId);
      onDone?.();
    } catch (error) {
      if (isApiError(error, 'ONEC_ALLOCATION_BATCH_CONFLICT')) {
        const details = (error as ApiError).details as { failures?: Array<{ index: number; code: string; message: string }> } | undefined;
        setConflict(mapBatchFailures(details?.failures ?? [], built.request, response));
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось распределить');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Сначала права (CR1-4): без procurement.manage загрузка не начинается — объясняем сразу.
  if (manageLoading) return <Spin />;
  if (!canManage) {
    return <Alert showIcon type="warning" message="Подбор и распределение приходов доступны только с правом на закупки (procurement.manage)" />;
  }
  if (state.status === 'loading') return <Spin />;
  if (state.status === 'disabled') {
    return <Alert showIcon type="info" message="Документы 1С пока не включены" />;
  }
  if (state.status === 'notfound') {
    return <Alert showIcon type="error" message="Документ не найден или недоступен" />;
  }
  if (state.status === 'error') {
    return <Alert showIcon type="error" message="Не удалось открыть подбор заказов" description={state.message} />;
  }
  if (!response || !summary) return null;

  const eligibleLines = response.lines.filter((line) => line.skipReason === null);
  // После конфликта отправка недоступна до «Подобрать заново» (CR1-1): данные в панели устарели.
  const submitDisabled = submitting || conflict !== null || summary.overrun || summary.ordersCount === 0;

  return (
    <RrScreen>
    <div className="rr-pad">
      <div className="rr-summary">
        <div className="rr-kpi"><div className="rr-kpi-l">Строк прихода</div><div className="rr-kpi-v">{summary.linesCount}</div></div>
        <div className="rr-kpi"><div className="rr-kpi-l">Заказов в распределении</div><div className="rr-kpi-v">{summary.ordersCount}</div></div>
        <div className="rr-kpi">
          <div className="rr-kpi-l">На склад / излишек</div>
          <div className="rr-kpi-v">{summary.surplusByUnit.length === 0 ? '—' : summary.surplusByUnit.map((entry) => `${round2(entry.surplusInDocUnit)} ${onecUnitLabel(entry.unit, null)}`).join(' + ')}</div>
        </div>
        <div className="rr-kpi">
          <div className="rr-kpi-l">Проверка</div>
          <div className="rr-kpi-v" style={{ fontSize: 15, color: summary.overrun ? 'var(--rr-bad)' : 'var(--rr-ok)' }}>
            {summary.overrun ? 'Есть перебор' : 'Можно распределять'}
          </div>
        </div>
      </div>
      {response.proposalLimitReached && (
        <Alert
          showIcon
          type="info"
          message={`Предложено ${response.proposalLimit} распределений — это максимум одной команды. Распределите их, затем нажмите «Подобрать заново» для остальных заказов.`}
        />
      )}
      <div className="rr-hint-box">
        Заказы подобраны автоматически: сначала указанные в 1С, затем по дате запуска в цех, без отметки «Закуплено»,
        совпадению поставщика. Количество раскладывается по очереди с запасом {response.wastePercent}% на обрезки
        (только для потребности по площади); листы пересчитаны в м² по размеру листа. Всё можно поправить до подтверждения.
      </div>

      {conflict && (
        <Alert
          showIcon
          type="error"
          message="Не удалось распределить: часть данных устарела"
          description={(
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {conflict.map((failure) => (
                <div key={failure.index}>
                  {failure.lineNo != null ? `Строка ${failure.lineNo}` : `Позиция ${failure.index + 1}`}
                  {failure.materialName ? ` · ${failure.materialName}` : ''}
                  {failure.orderName ? ` · заказ ${failure.orderName}` : ''}: {failure.message}
                </div>
              ))}
              <Button size="small" onClick={reloadFresh}>Подобрать заново</Button>
            </Space>
          )}
        />
      )}

      {eligibleLines.length === 0 && response.lines.length > 0 && (
        <div className="rr-hint-box">
          {response.lines.every((line) => line.skipReason === 'fully_allocated')
            ? 'Весь приход уже распределён.'
            : 'Подобрать нечего: строки прихода распределены, не сопоставлены с материалами ERP или указаны в единицах, которые нельзя пересчитать. Причина — у каждой строки ниже.'}
        </div>
      )}

      {response.lines.map((line) => (
        <SuggestionLineCard
          key={line.lineId}
          line={line}
          lineDraft={getLineDraft(draft, line.lineId)}
          wastePercent={response.wastePercent}
          onToggle={(orderId, checked) => toggleCandidate(line.lineId, orderId, checked)}
          onQuantityChange={(orderId, quantity) => changeQuantity(line.lineId, orderId, quantity)}
          onResuggest={() => resuggestLine(line)}
        />
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tooltip title={submitDisabled ? submitBlockReason(summary, submitting, conflict !== null) : undefined}>
          <Button type="primary" disabled={submitDisabled} loading={submitting} onClick={() => void handleSubmit()}>
            Распределить выбранное ({summary.ordersCount} заказов)
          </Button>
        </Tooltip>
        <span className="rr-sub" style={{ fontSize: 13 }}>
          Одна команда «всё или ничего»: версии закупа, остаток строк и отпечаток потребности проверяются сервером;
          отметка «Закуплено» ставится по приходу автоматически.
        </span>
      </div>
    </div>
    </RrScreen>
  );
}

function submitBlockReason(summary: { overrun: boolean; ordersCount: number }, submitting: boolean, conflicted = false): string | undefined {
  if (submitting) return undefined;
  if (conflicted) return 'Данные изменились — нажмите «Подобрать заново»';
  if (summary.overrun) return 'Уменьшите количества — есть перебор сверх остатка строки';
  if (summary.ordersCount === 0) return 'Отметьте хотя бы одного кандидата';
  return undefined;
}

interface SuggestionLineCardProps {
  line: AllocationSuggestionLine;
  lineDraft: ReturnType<typeof getLineDraft>;
  wastePercent: number;
  onToggle: (orderId: number, checked: boolean) => void;
  onQuantityChange: (orderId: number, quantity: number) => void;
  onResuggest: () => void;
}

function SuggestionLineCard({ line, lineDraft, onToggle, onQuantityChange, onResuggest }: SuggestionLineCardProps) {
  const totals = computeLineTotals(line, lineDraft);
  const status = lineCheckStatus(totals);
  const unitLabel = onecUnitLabel(line.docUnit, null);
  const demandEquivalent = lineCapacityDemandEquivalent(line);

  return (
    <div className="rr-line">
      <div className="rr-line-head">
        <b>Строка {line.lineNo}</b>
        <span>{line.material?.name ?? line.nomenclatureName ?? '—'}</span>
        <span className="rr-tag rr-tag--plain rr-num">
          {round2(line.capacityInDocUnit)} {unitLabel}
          {line.docUnit === 'sheet' && line.demandUnit === 'm2' && demandEquivalent != null
            ? ` = ${round2(demandEquivalent)} ${DEMAND_UNIT_LABEL.m2}`
            : ''}
        </span>
        <span className="rr-muted" style={{ marginLeft: 'auto' }}>кандидатов: {line.candidates.length}</span>
      </div>
      {line.skipReason && <div className="rr-hint-box" style={{ margin: 12 }}>{SKIP_REASON_LABEL[line.skipReason]}</div>}

      {line.alreadyAllocated.length > 0 && (
        <div className="rr-sub" style={{ padding: '8px 12px', borderBottom: '1px solid var(--rr-border)' }}>
          Уже распределено: {line.alreadyAllocated.map((entry) => (
            <span key={entry.orderId}>
              <Link to={`/order-resource-requirements/show/${entry.orderId}`}>{entry.orderName || `#${entry.orderId}`}</Link>
              {' '}({round2(entry.quantityInDocUnit)} {unitLabel}){' '}
            </span>
          ))}
        </div>
      )}

      {line.candidates.length === 0 ? (
        !line.skipReason && <div className="rr-hint-box" style={{ margin: 12 }}>Нет заказов с дефицитом этого материала — весь приход уйдёт на склад.</div>
      ) : (
        <Table<AllocationSuggestionCandidate>
          size="small"
          rowKey="orderId"
          dataSource={line.candidates}
          pagination={false}
        >
          <Table.Column<AllocationSuggestionCandidate>
            key="checked"
            width={40}
            render={(_, candidate) => {
              const display = candidateDisplay(line, candidate, lineDraft);
              return (
                <Checkbox
                  checked={display.checked}
                  aria-label={`Распределить на заказ ${candidate.fullNumber}`}
                  onChange={(event) => onToggle(candidate.orderId, event.target.checked)}
                />
              );
            }}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="order"
            title="Заказ"
            render={(_, candidate) => (
              <div>
                <b><Link to={`/order-resource-requirements/show/${candidate.orderId}`}>{candidate.fullNumber}</Link></b>
                <div className="rr-sub">{candidate.clientName ?? '—'}</div>
              </div>
            )}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="due"
            title="Нужно к"
            render={(_, candidate) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                <span className="rr-num">{candidate.dueDate ? formatDateOnly(candidate.dueDate) : '—'}</span>
                <span className={`rr-tag rr-tag--${URGENCY_TONE[candidate.urgency]}`}>{dueText(candidate)}</span>
              </div>
            )}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="reasons"
            title="Почему предложен"
            render={(_, candidate) => (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {candidate.reasons.map((reason) => (
                  <span key={reason.code} className={`rr-tag rr-tag--${REASON_TONE[reason.tone]}`}>{reason.label}</span>
                ))}
              </span>
            )}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="deficit"
            title="Дефицит"
            align="right"
            render={(_, candidate) => `${round2(candidate.deficitInDemandUnit)} ${DEMAND_UNIT_LABEL[candidate.demandUnit]}`}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="quantity"
            title={`Распределить, ${unitLabel}`}
            align="right"
            render={(_, candidate) => {
              const display = candidateDisplay(line, candidate, lineDraft);
              return (
                <InputNumber<number>
                  size="small"
                  min={0}
                  precision={3}
                  step={0.1}
                  disabled={!display.checked}
                  value={display.quantityInDocUnit}
                  onChange={(value) => onQuantityChange(candidate.orderId, value ?? 0)}
                  aria-label={`Количество для заказа ${candidate.fullNumber}`}
                />
              );
            }}
          />
          <Table.Column<AllocationSuggestionCandidate>
            key="approx"
            title="≈"
            align="right"
            render={(_, candidate) => {
              const display = candidateDisplay(line, candidate, lineDraft);
              return display.quantityInDemandUnit != null
                ? <span className="rr-muted rr-num">{round2(display.quantityInDemandUnit)} {DEMAND_UNIT_LABEL[candidate.demandUnit]}</span>
                : <span className="rr-muted">—</span>;
            }}
          />
        </Table>
      )}

      <div className="rr-line-foot">
        <span className="rr-num">Распределено <b>{round2(totals.distributedInDocUnit)}</b> из {round2(line.capacityInDocUnit)} {unitLabel}</span>
        {status === 'overrun' && <span className="rr-tag rr-tag--bad">перебор {round2(Math.abs(totals.leftInDocUnit))} {unitLabel} — уменьшите количества</span>}
        {status === 'surplus' && <span className="rr-tag rr-tag--warn">на склад / излишек {round2(totals.surplusInDocUnit)} {unitLabel}</span>}
        {status === 'exact' && <span className="rr-tag rr-tag--ok">строка распределена полностью</span>}
        {line.candidates.length > 0 && <Button size="small" style={{ marginLeft: 'auto' }} onClick={onResuggest}>Подобрать заново</Button>}
      </div>
    </div>
  );
}

function round2(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

function formatDateOnly(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}
