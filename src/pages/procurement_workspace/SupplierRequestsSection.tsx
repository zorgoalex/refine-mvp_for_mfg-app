import { CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Typography, message } from 'antd';
import { useGetIdentity } from '@refinedev/core';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';

import { ApiError, isApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import { supplierRequestsApi } from '../../api/supplierRequestsApi';
import type { OnecUnitCode } from '../../api/types/onecDocumentsApi.types';
import type {
  CreateSupplierRequestDraftsResultDto,
  SupplierRequestCardDto,
  SupplierRequestLineDto,
  SupplierRequestLineOrderDto,
  SupplierRequestPossibleMatchDto,
  SupplierRequestReceiptLinkDto,
  SupplierRequestsListResponseDto,
  SupplierRequestStatus,
} from '../../api/types/supplierRequestsApi.types';
import type { UserIdentity } from '../../types/auth';
import { formatDate } from '../../utils/dateFormat';
import { Segmented } from '../../ui/Segmented';
import { Table, Tooltip, type TableProps } from '../../ui/tooltipDelay';
import { onecUnitLabel } from '../onec_purchase_documents/onecDocumentsHelpers';
import { useProcurementPermission } from '../order_resource_requirements/ProcurementParts';
import { RrScreen } from './RrScreen';
import { useSelect } from '../../ui/refineSelect';
import {
  buildDraftsBody,
  buildSupplierCopyText,
  buildUpdatePatchBody,
  clearDraftPreview,
  computeLineStock,
  computeRequestSteps,
  formatDemandQuantity,
  formatLineItemText,
  formatRequestQuantity,
  fulfillmentTag,
  groupDraftPreviewBySupplier,
  hiddenOrdersLabel,
  isStockNegative,
  loadDraftPreview,
  possibleMatchDefaultQuantity,
  possibleMatchMaxQuantity,
  receiptLineLabel,
  REQUEST_STEP_LABELS,
  requestsStatusCounts,
  resolveDraftRequestId,
  loadDraftRequestId,
  saveDraftRequestId,
  hasRequestSupplier,
  hasUnsavedRequestChanges,
  statusFilterToParam,
  type StepState,
  stepIcon,
  SUPPLIER_REQUEST_STATUS_LABELS,
  summarizeDraftsResult,
  supplierRequestErrorMessage,
  type DraftPreviewItem,
  type DraftRequestIdState,
  type RequestsStatusFilter,
} from './supplierRequestsHelpers';

const STATUS_TONE: Record<SupplierRequestStatus, string> = { draft: 'none', sent: 'info', closed: 'ok', cancelled: 'bad' };

export interface SupplierRequestsSectionProps {
  /** Раздел виден: иначе без опроса сервера (та же логика, что у остальных секций). */
  active: boolean;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SupplierRequestsListResponseDto };

/**
 * «Заявки поставщикам» (план §5.5, §6): список + черновик из выделения рабочего списка
 * (превью в sessionStorage) + карточка-Drawer с правкой черновика и переходами статуса.
 */
export function SupplierRequestsSection({ active }: SupplierRequestsSectionProps) {
  const { canManage, manageLoading } = useProcurementPermission();
  const [statusFilter, setStatusFilter] = useState<RequestsStatusFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const [listState, setListState] = useState<ListState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setListState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    supplierRequestsApi.list({ status: statusFilterToParam(statusFilter), search: search || undefined })
      .then((data) => { if (alive) setListState({ status: 'ready', data }); })
      .catch((error: unknown) => {
        if (alive) setListState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить заявки' });
      });
    return () => { alive = false; };
  }, [active, statusFilter, search, revision]);

  const [openId, setOpenId] = useState<number | null>(null);

  // Черновик из выделения рабочего списка (план §6): подхватывается, когда известен пользователь — превью и
  // ключ повтора хранятся по его id (CR4-1), чужие не показываются.
  const { data: identity } = useGetIdentity<UserIdentity>();
  const userId = identity?.id === undefined || identity?.id === null ? null : String(identity.id);
  const [draftPreview, setDraftPreview] = useState<{ items: DraftPreviewItem[]; idState: DraftRequestIdState } | null>(null);
  useEffect(() => {
    if (userId === null) { setDraftPreview(null); return; }
    const items = loadDraftPreview(userId);
    setDraftPreview(!items || items.length === 0
      ? null
      : { items, idState: resolveDraftRequestId(items, loadDraftRequestId(userId), () => crypto.randomUUID()) });
  }, [userId]);
  const [creatingDrafts, setCreatingDrafts] = useState(false);
  const draftGroups = useMemo(() => (draftPreview ? groupDraftPreviewBySupplier(draftPreview.items) : []), [draftPreview]);

  const cancelDraftPreview = useCallback(() => {
    if (userId !== null) clearDraftPreview(userId);
    setDraftPreview(null);
  }, [userId]);

  const createDrafts = useCallback(async () => {
    if (!draftPreview || userId === null) return;
    setCreatingDrafts(true);
    try {
      saveDraftRequestId(userId, draftPreview.idState);
      const body = buildDraftsBody(draftPreview.items, draftPreview.idState.requestId);
      const result = await supplierRequestsApi.createDrafts(body);
      const summary = summarizeDraftsResult(result);
      message.success(summary.createdMessage);
      if (summary.skippedMessage) message.warning(summary.skippedMessage);
      clearDraftPreview(userId);
      setDraftPreview(null);
      refresh();
      if (result.requests[0]) setOpenId(result.requests[0].requestId);
    } catch (error) {
      if (isApiError(error, 'SUPPLIER_REQUEST_NOTHING_TO_ORDER')) {
        const details = (error as ApiError).details as { skipped?: CreateSupplierRequestDraftsResultDto['skipped'] } | undefined;
        const summary = summarizeDraftsResult({ requests: [], skipped: details?.skipped ?? [] });
        message.error(summary.skippedMessage ?? 'Заказывать нечего: у выбранных позиций нет дефицита');
      } else {
        message.error(supplierRequestErrorMessage(error instanceof ApiError ? error : { message: error instanceof Error ? error.message : undefined }));
      }
    } finally {
      setCreatingDrafts(false);
    }
  }, [draftPreview, refresh, userId]);

  const data = listState.status === 'ready' ? listState.data.data : EMPTY_LIST;
  const counts = listState.status === 'ready' ? requestsStatusCounts(listState.data.counts) : { draft: 0, sent: 0, closed: 0, cancelled: 0, all: 0 };

  const columns: TableProps<SupplierRequestsListResponseDto['data'][number]>['columns'] = [
    {
      title: 'Заявка',
      key: 'request',
      width: 140,
      render: (_value, request) => (
        <div>
          <b>{request.requestNumber}</b>
          <div className="rr-sub">{formatDate(request.createdAt)}</div>
        </div>
      ),
    },
    {
      title: 'Поставщик',
      key: 'supplier',
      width: 180,
      render: (_value, request) => <span className={request.supplierId == null ? 'rr-muted' : undefined}>{request.supplierName}</span>,
    },
    {
      title: 'Позиции',
      key: 'lines',
      render: (_value, request) => (
        <div>
          {request.lines.map((line, index) => <div key={index}>{formatLineItemText(line)}</div>)}
        </div>
      ),
    },
    {
      title: 'Сверка',
      key: 'steps',
      width: 260,
      render: (_value, request) => <StepsCell status={request.status} receiptState={request.receiptState ?? 'none'} />,
    },
    {
      title: 'Статус',
      key: 'status',
      width: 120,
      render: (_value, request) => <span className={`rr-tag rr-tag--${STATUS_TONE[request.status]}`}>{SUPPLIER_REQUEST_STATUS_LABELS[request.status]}</span>,
    },
    {
      title: 'Заказов',
      key: 'orders',
      width: 140,
      render: (_value, request) => (
        <span>
          {request.ordersCount}
          {hiddenOrdersLabel(request.hiddenOrdersCount) && <div className="rr-sub">{hiddenOrdersLabel(request.hiddenOrdersCount)}</div>}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="rr-appbar">
        <span className="rr-ttl">Заявки поставщикам</span>
        <span className="rr-muted">заявка → приход 1С → оплата 1С (сверка — позже)</span>
      </div>

      <div className="rr-pad">
        {draftPreview && draftGroups.length > 0 && (
          <div className="rr-line" style={{ borderColor: 'var(--rr-accent)' }}>
            <div className="rr-line-head" style={{ background: 'var(--rr-accent-soft)' }}>
              <b>Черновики заявок из выделенного</b>
              <span className="rr-muted">сгруппировано по поставщикам</span>
            </div>
            <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {draftGroups.map((group) => (
                <div key={group.supplierKey}>
                  <b>{group.supplierName}</b>
                  {group.materials.map((materialGroup) => (
                    <div key={materialGroup.resourceKey} className="rr-sub" style={{ marginLeft: 12 }}>
                      {materialGroup.materialName} — <span className="rr-num">{formatDemandQuantity(materialGroup.deficitTotal, materialGroup.unit)}</span>
                      {' '}(заказы {materialGroup.orders.join(', ')})
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="rr-line-foot">
              <Tooltip title={!canManage ? 'Нужно право procurement.manage' : undefined}>
                <Button type="primary" loading={creatingDrafts} disabled={!canManage || manageLoading} onClick={() => void createDrafts()}>
                  Создать {draftGroups.length} {draftGroups.length === 1 ? 'заявку' : 'заявки'}
                </Button>
              </Tooltip>
              <Button onClick={cancelDraftPreview} disabled={creatingDrafts}>Отмена</Button>
            </div>
          </div>
        )}

        <div className="rr-toolbar" style={{ padding: 0, border: 'none' }}>
          <Segmented
            aria-label="Статус заявки"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as RequestsStatusFilter)}
            options={[
              { value: 'draft', label: <span>Черновики<span className="rr-badge">{counts.draft}</span></span> },
              { value: 'sent', label: <span>Отправлены<span className="rr-badge">{counts.sent}</span></span> },
              { value: 'closed', label: <span>Закрытые<span className="rr-badge">{counts.closed}</span></span> },
              { value: 'cancelled', label: <span>Отменённые<span className="rr-badge">{counts.cancelled}</span></span> },
              { value: 'all', label: <span>Все<span className="rr-badge">{counts.all}</span></span> },
            ]}
          />
          <Input allowClear placeholder="Номер заявки, поставщик, материал" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} style={{ width: 260 }} />
        </div>

        {listState.status === 'error' && <Alert type="error" showIcon message={listState.message} />}
        {listState.status === 'ready' && listState.data.truncated && (
          <Alert type="info" showIcon message={`Показаны первые ${listState.data.data.length} заявок — уточните поиск или фильтр по статусу, чтобы найти остальные`} />
        )}

        <Table<SupplierRequestsListResponseDto['data'][number]>
          className="rr-table"
          rowKey="requestId"
          dataSource={data}
          columns={columns}
          loading={listState.status === 'loading'}
          pagination={false}
          onRow={(request) => ({ onClick: () => setOpenId(request.requestId), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty description="Заявок нет" /> }}
        />
        <div className="rr-hint">Отправленная заявка отмечается в рабочем списке как «заказано». Приход засчитывается по привязке к заявке (карточка заявки → «Привязать»); оплаты — позже. Если остаток не нужен — закройте заявку вручную: непокрытый остаток вернётся в рабочий список.</div>
      </div>

      <SupplierRequestDrawer
        // Отдельный экземпляр на заявку (CR2-4): поздний ответ команды по закрытой заявке не подменит открытую.
        key={openId ?? 'none'}
        requestId={openId}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
        canManage={canManage}
        manageLoading={manageLoading}
      />
    </div>
  );
}

function StepsCell({ status, receiptState }: { status: SupplierRequestStatus; receiptState: 'none' | 'partial' | 'done' }) {
  const steps = computeRequestSteps(status, receiptState);
  const values: Array<{ state: StepState; tooltip?: string }> = [
    { state: steps.request },
    { state: steps.receipt },
    { state: steps.payment, tooltip: 'оплаты — позже' },
  ];
  return (
    <div className="rr-steps">
      {values.map((entry, index) => (
        <span key={index}>
          <Tooltip title={entry.tooltip}>
            <span className={`rr-step rr-step--${entry.state}`}>{stepIcon(entry.state)} {REQUEST_STEP_LABELS[index]}</span>
          </Tooltip>
          {index < values.length - 1 && <span className="rr-muted"> → </span>}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Карточка заявки (Drawer)
// ---------------------------------------------------------------------------

interface LineEditValues { quantity: number; orders: Record<number, number> }

function buildLineEdits(card: SupplierRequestCardDto): Record<number, LineEditValues> {
  const result: Record<number, LineEditValues> = {};
  for (const line of card.lineItems) {
    result[line.lineId] = { quantity: line.quantity, orders: Object.fromEntries(line.orders.map((order) => [order.lineOrderId, order.quantity])) };
  }
  return result;
}

type CardState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; card: SupplierRequestCardDto };

interface SupplierRequestDrawerProps {
  requestId: number | null;
  onClose: () => void;
  onChanged: () => void;
  canManage: boolean;
  manageLoading: boolean;
}

function SupplierRequestDrawer({ requestId, onClose, onChanged, canManage, manageLoading }: SupplierRequestDrawerProps) {
  const [state, setState] = useState<CardState>({ status: 'idle' });
  const [supplierIdValue, setSupplierIdValue] = useState<number | null>(null);
  // Поставщик уходит в правку только после явного изменения поля (CR2-1): иначе поставщик из 1С (c:/n:,
  // supplierId=null) стёрся бы сохранением комментария.
  const [supplierTouched, setSupplierTouched] = useState(false);
  const [expectedDateValue, setExpectedDateValue] = useState<string | null>(null);
  const [commentValue, setCommentValue] = useState<string>('');
  const [lineEdits, setLineEdits] = useState<Record<number, LineEditValues>>({});
  // Строки, убранные из черновика до сохранения (CR4-2): в PATCH не попадают — сервер их удаляет.
  const [removedLines, setRemovedLines] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [busyTransition, setBusyTransition] = useState<'send' | 'close' | 'cancel' | null>(null);
  // Ключ занятой связи (ф.3б) — блокирует конкретную кнопку «Привязать»/«Отвязать», не всю карточку.
  const [linkBusyKey, setLinkBusyKey] = useState<string | null>(null);

  const { selectProps: supplierSelectProps } = useSelect({ resource: 'suppliers', optionLabel: 'supplier_name', optionValue: 'supplier_id' });

  const applyCard = useCallback((card: SupplierRequestCardDto) => {
    setState({ status: 'ready', card });
    setSupplierIdValue(card.supplierId);
    setSupplierTouched(false);
    setExpectedDateValue(card.expectedDate);
    setCommentValue(card.comment ?? '');
    setLineEdits(buildLineEdits(card));
    setRemovedLines(new Set());
  }, []);

  useEffect(() => {
    if (requestId == null) { setState({ status: 'idle' }); return undefined; }
    let alive = true;
    setState({ status: 'loading' });
    supplierRequestsApi.card(requestId)
      .then((card) => { if (alive) applyCard(card); })
      .catch((error: unknown) => { if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось открыть заявку' }); });
    return () => { alive = false; };
  }, [requestId, applyCard]);

  const handleCommandError = useCallback((error: unknown) => {
    if (isApiError(error, 'SUPPLIER_REQUEST_VERSION_CONFLICT')) {
      const details = (error as ApiError).details as { request?: SupplierRequestCardDto } | undefined;
      if (details?.request) applyCard(details.request);
      message.warning('Заявку уже изменил другой пользователь. Показана актуальная версия');
      onChanged();
      return;
    }
    message.error(supplierRequestErrorMessage(error instanceof ApiError ? error : { message: error instanceof Error ? error.message : undefined }));
  }, [applyCard, onChanged]);

  const card = state.status === 'ready' ? state.card : null;
  const editable = Boolean(card?.actions.edit);

  // Ответ, пришедший после закрытия карточки, не применяется (CR2-2): экземпляр — на одну заявку (key), а флаг
  // снимается при размонтировании.
  const aliveRef = useRef(true);
  // setup ставит флаг, cleanup снимает: под StrictMode (setup → cleanup → setup) флаг остаётся true (CR3-1).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const reloadCard = useCallback(async () => {
    if (requestId == null) return;
    const fresh = await supplierRequestsApi.card(requestId);
    if (aliveRef.current && fresh.requestId === requestId) applyCard(fresh);
  }, [requestId, applyCard]);

  // «Привязать» (ф.3б): documentId/lineId/allocationId — из выбранного «возможного совпадения», сам заказ строки —
  // из карточки заявки. После успеха/конфликта версии карточка перечитывается целиком — проще и надёжнее частичного патча.
  const handleLinkReceipt = async (match: SupplierRequestPossibleMatchDto, lineOrderId: number, quantity: number) => {
    const key = `link:${match.documentId}:${match.lineId}:${match.allocationId}:${lineOrderId}`;
    setLinkBusyKey(key);
    try {
      const result = await onecDocumentsApi.linkToRequest(match.documentId, match.lineId, match.allocationId, {
        lineOrderId, quantity, expectedVersion: match.procurementVersion,
      });
      if (result.supplierCheck === 'unknown') {
        message.warning('Приход привязан. Поставщика прихода не удалось сверить с поставщиком заявки — проверьте вручную.');
      } else {
        message.success(result.changed ? 'Приход привязан к заявке' : 'Уже привязано с таким количеством');
      }
      await reloadCard();
      onChanged();
    } catch (error) {
      if (isApiError(error, 'PROCUREMENT_VERSION_CONFLICT')) {
        message.warning('Данные устарели — карточка обновлена');
        await reloadCard().catch(() => {});
        onChanged();
      } else {
        message.error(supplierRequestErrorMessage(error instanceof ApiError ? error : { message: error instanceof Error ? error.message : undefined }));
      }
    } finally {
      setLinkBusyKey(null);
    }
  };

  const handleUnlinkReceipt = async (receipt: SupplierRequestReceiptLinkDto) => {
    const confirmed = await confirmModal('Отвязать приход', `Отвязать приход ${receipt.documentNumber} от заявки?`);
    if (!confirmed) return;
    const key = `unlink:${receipt.linkId}`;
    setLinkBusyKey(key);
    try {
      await onecDocumentsApi.unlinkFromRequest(receipt.documentId, receipt.lineId, receipt.allocationId, receipt.linkId, {
        expectedVersion: receipt.procurementVersion,
      });
      message.success('Приход отвязан');
      await reloadCard();
      onChanged();
    } catch (error) {
      if (isApiError(error, 'PROCUREMENT_VERSION_CONFLICT')) {
        message.warning('Данные устарели — карточка обновлена');
        await reloadCard().catch(() => {});
        onChanged();
      } else {
        message.error(supplierRequestErrorMessage(error instanceof ApiError ? error : { message: error instanceof Error ? error.message : undefined }));
      }
    } finally {
      setLinkBusyKey(null);
    }
  };

  const handleSave = async () => {
    if (!card) return;
    setSaving(true);
    try {
      const body = buildUpdatePatchBody({
        expectedVersion: card.version,
        comment: commentValue.trim() || null,
        expectedDate: expectedDateValue,
        supplierId: supplierTouched ? supplierIdValue : undefined,
        lines: card.lineItems.filter((line) => !removedLines.has(line.lineId)).map((line) => ({
          lineId: line.lineId,
          quantity: lineEdits[line.lineId]?.quantity ?? line.quantity,
          orders: Object.entries(lineEdits[line.lineId]?.orders ?? {}).map(([lineOrderId, quantity]) => ({ lineOrderId: Number(lineOrderId), quantity })),
        })),
      });
      const result = await supplierRequestsApi.update(card.requestId, body);
      applyCard(result.request);
      message.success(result.changed ? 'Сохранено' : 'Изменений нет');
      onChanged();
    } catch (error) {
      handleCommandError(error);
    } finally {
      setSaving(false);
    }
  };

  const doTransition = async (transition: 'send' | 'close' | 'cancel') => {
    if (!card) return;
    const confirmed = await confirmModal(TRANSITION_TITLES[transition], TRANSITION_CONTENTS[transition](card));
    if (!confirmed) return;
    setBusyTransition(transition);
    try {
      const method = transition === 'send' ? supplierRequestsApi.send : transition === 'close' ? supplierRequestsApi.close : supplierRequestsApi.cancel;
      const result = await method(card.requestId, { expectedVersion: card.version });
      applyCard(result.request);
      message.success(result.changed ? TRANSITION_SUCCESS[transition] : 'Уже в этом статусе');
      onChanged();
    } catch (error) {
      handleCommandError(error);
    } finally {
      setBusyTransition(null);
    }
  };

  const copyText = async () => {
    if (!card) return;
    const text = buildSupplierCopyText(card);
    try {
      await navigator.clipboard.writeText(text);
      message.success('Текст скопирован');
    } catch {
      message.error('Не удалось скопировать — браузер отклонил доступ к буферу обмена');
    }
  };

  // Любые несохранённые правки блокируют «Отправить» (CR3-2): иначе отправилась бы сохранённая версия.
  const dirty = card !== null && (removedLines.size > 0 || hasUnsavedRequestChanges(card, {
    supplierTouched, comment: commentValue, expectedDate: expectedDateValue, lineEdits,
  }, buildLineEdits(card)));
  const keptLines = card ? card.lineItems.filter((line) => !removedLines.has(line.lineId)) : [];
  const anyStockNegative = card
    ? keptLines.some((line) => isStockNegative(computeLineStock(lineEdits[line.lineId]?.quantity ?? line.quantity, Object.values(lineEdits[line.lineId]?.orders ?? {}), line.hiddenOrdersQuantity)))
    : false;

  return (
    <Drawer
      open={requestId != null}
      onClose={onClose}
      width={960}
      title={card ? (
        <Space>
          <b>{card.requestNumber}</b>
          <span className={`rr-tag rr-tag--${STATUS_TONE[card.status]}`}>{SUPPLIER_REQUEST_STATUS_LABELS[card.status]}</span>
          <span className="rr-muted">{card.supplierName}</span>
        </Space>
      ) : 'Заявка поставщику'}
      destroyOnClose
    >
      {state.status === 'loading' && <Typography.Text type="secondary">Загрузка…</Typography.Text>}
      {state.status === 'error' && <Alert type="error" showIcon message={state.message} />}
      {card && (
        // Drawer рендерится в портал вне экрана — стили rr-* и токены темы подключаются своей обёрткой.
        <RrScreen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {editable ? (
            <Space wrap align="start">
              <div>
                <div className="rr-sub">Поставщик</div>
                <Select
                  {...supplierSelectProps}
                  allowClear
                  style={{ width: 240 }}
                  placeholder={!supplierTouched && hasRequestSupplier(card) ? card.supplierName : 'Поставщик не указан'}
                  dropdownMatchSelectWidth={320}
                  value={supplierIdValue ?? undefined}
                  onChange={(value) => { setSupplierTouched(true); setSupplierIdValue((value as number | undefined) ?? null); }}
                />
              </div>
              <div>
                <div className="rr-sub">Ожидаем к</div>
                <DatePicker
                  format="DD.MM.YYYY"
                  placeholder="Выберите дату"
                  style={{ width: 160 }}
                  value={expectedDateValue ? dayjs(expectedDateValue) : null}
                  onChange={(value) => setExpectedDateValue(value ? value.format('YYYY-MM-DD') : null)}
                />
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="rr-sub">Комментарий</div>
                <Input.TextArea rows={1} maxLength={2000} value={commentValue} onChange={(event) => setCommentValue(event.target.value)} />
              </div>
            </Space>
          ) : (
            <Space wrap>
              <span>Поставщик: <b>{card.supplierName}</b></span>
              {card.expectedDate && <span>Ожидаем к: <b>{formatDate(card.expectedDate)}</b></span>}
              {card.comment && <span className="rr-muted">{card.comment}</span>}
            </Space>
          )}

          {card.status === 'sent' && card.receiptState === 'done' && (
            <Alert showIcon type="info" message="Всё заказанное пришло — заявку можно закрыть" />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {keptLines.map((line) => (
              <SupplierRequestLineCard
                key={line.lineId}
                line={line}
                editable={editable}
                // Последнюю строку не убрать: пустой заявки не бывает — её отменяют.
                onRemove={keptLines.length > 1 ? () => setRemovedLines((current) => new Set(current).add(line.lineId)) : undefined}
                edit={lineEdits[line.lineId] ?? { quantity: line.quantity, orders: {} }}
                onChange={(next) => setLineEdits((current) => ({ ...current, [line.lineId]: next }))}
                requestStatus={card.status}
                canManage={canManage}
                linkBusyKey={linkBusyKey}
                onLinkReceipt={handleLinkReceipt}
                onUnlinkReceipt={handleUnlinkReceipt}
              />
            ))}
          </div>

          <Space wrap>
            {editable && (
              <Tooltip title={anyStockNegative ? 'Уменьшите количество по заказам — на склад не может быть отрицательным' : undefined}>
                <Button type="primary" loading={saving} disabled={!canManage || manageLoading || anyStockNegative} onClick={() => void handleSave()}>Сохранить</Button>
              </Tooltip>
            )}
            {card.actions.send && (
              <Tooltip title={!hasRequestSupplier(card) ? 'Укажите поставщика перед отправкой' : dirty ? 'Сначала сохраните изменения' : undefined}>
                <Button loading={busyTransition === 'send'} disabled={!canManage || manageLoading || !hasRequestSupplier(card) || dirty} onClick={() => void doTransition('send')}>Отправить</Button>
              </Tooltip>
            )}
            {card.actions.close && (
              <Button loading={busyTransition === 'close'} disabled={!canManage || manageLoading} onClick={() => void doTransition('close')}>Закрыть заявку</Button>
            )}
            {card.actions.cancel && (
              <Button danger loading={busyTransition === 'cancel'} disabled={!canManage || manageLoading} onClick={() => void doTransition('cancel')}>Отменить заявку</Button>
            )}
            {/* Копируется сохранённая заявка — при несохранённых правках текст разошёлся бы с экраном (CR4-3). */}
            <Tooltip title={dirty ? 'Сначала сохраните изменения' : undefined}>
              <Button icon={<CopyOutlined />} disabled={dirty} onClick={() => void copyText()}>Скопировать текст для поставщика</Button>
            </Tooltip>
          </Space>
        </div>
        </RrScreen>
      )}
    </Drawer>
  );
}

interface SupplierRequestLineCardProps {
  line: SupplierRequestLineDto;
  editable: boolean;
  edit: LineEditValues;
  onChange: (next: LineEditValues) => void;
  /** Убрать материал из черновика; нет — строка последняя (тогда заявку отменяют). */
  onRemove?: () => void;
  requestStatus: SupplierRequestStatus;
  canManage: boolean;
  /** Ключ занятой связи (ф.3б) — блокирует только свою кнопку «Привязать»/«Отвязать». */
  linkBusyKey: string | null;
  onLinkReceipt: (match: SupplierRequestPossibleMatchDto, lineOrderId: number, quantity: number) => void;
  onUnlinkReceipt: (receipt: SupplierRequestReceiptLinkDto) => void;
}

function SupplierRequestLineCard({
  line, editable, edit, onChange, onRemove, requestStatus, canManage, linkBusyKey, onLinkReceipt, onUnlinkReceipt,
}: SupplierRequestLineCardProps) {
  const unitLabel = onecUnitLabel(line.unit, null);
  // Просмотр — сохранённый остаток; правка черновика — предпросмотр (заказы в корзине при сохранении уйдут; CR3-3).
  const stock = editable ? computeLineStock(edit.quantity, Object.values(edit.orders), line.hiddenOrdersQuantity) : line.stockQuantity;
  const negative = isStockNegative(stock);
  const demandEquivalent = line.unit === 'sheet' && line.sheetAreaM2 != null ? edit.quantity * line.sheetAreaM2 : null;
  const visibleOrders = line.orders.filter((order) => edit.orders[order.lineOrderId] !== undefined);
  const sheetPrecision = line.unit === 'sheet';

  return (
    <div className="rr-line">
      <div className="rr-line-head">
        <b>{line.name}</b>
        {editable ? (
          <>
            <InputNumber<number>
              value={edit.quantity}
              min={0}
              precision={sheetPrecision ? 0 : 3}
              step={sheetPrecision ? 1 : 0.1}
              aria-label={`Количество по строке ${line.name}`}
              onChange={(value) => onChange({ ...edit, quantity: value ?? 0 })}
            />
            <span className="rr-muted">{unitLabel}</span>
            <Tooltip title={onRemove ? undefined : 'Это единственный материал заявки — чтобы убрать всё, отмените заявку'}>
              <Button size="small" icon={<DeleteOutlined />} disabled={!onRemove} onClick={onRemove} aria-label={`Убрать ${line.name} из заявки`}>
                Убрать материал
              </Button>
            </Tooltip>
          </>
        ) : (
          <span className="rr-num">{formatRequestQuantity(line.quantity, line.unit)}</span>
        )}
        {demandEquivalent != null && <span className="rr-sub">≈ {formatDemandQuantity(demandEquivalent, 'm2')}</span>}
        <span className="rr-muted" style={{ marginLeft: 'auto' }}>
          на склад: <b className={negative ? 'rr-tag rr-tag--bad' : undefined}>{formatRequestQuantity(stock, line.unit)}</b>
        </span>
      </div>
      {visibleOrders.length === 0 ? (
        <div className="rr-hint-box" style={{ margin: 12 }}>Заказов на эту строку нет.</div>
      ) : (
        <Table
          size="small"
          rowKey="lineOrderId"
          dataSource={visibleOrders}
          pagination={false}
        >
          <Table.Column<typeof visibleOrders[number]>
            key="order"
            title="Заказ"
            render={(_value, order) => <span>{order.fullNumber}{order.clientName ? ` · ${order.clientName}` : ''}</span>}
          />
          <Table.Column<typeof visibleOrders[number]>
            key="quantity"
            title={`Количество, ${unitLabel}`}
            align="right"
            render={(_value, order) => (
              editable ? (
                <InputNumber<number>
                  size="small"
                  min={0}
                  precision={3}
                  step={0.1}
                  value={edit.orders[order.lineOrderId] ?? 0}
                  aria-label={`Количество для заказа ${order.fullNumber}`}
                  onChange={(value) => onChange({ ...edit, orders: { ...edit.orders, [order.lineOrderId]: value ?? 0 } })}
                />
              ) : <span className="rr-num">{formatRequestQuantity(edit.orders[order.lineOrderId] ?? 0, line.unit)}</span>
            )}
          />
          {!editable && (
            <Table.Column<typeof visibleOrders[number]>
              key="receipt"
              title="Приход"
              render={(_value, order) => (
                <OrderReceiptStatus
                  order={order}
                  unit={line.unit}
                  showPossibleMatches={requestStatus === 'sent'}
                  canManage={canManage}
                  linkBusyKey={linkBusyKey}
                  onLink={onLinkReceipt}
                  onUnlink={onUnlinkReceipt}
                />
              )}
            />
          )}
          {editable && (
            <Table.Column<typeof visibleOrders[number]>
              key="remove"
              width={40}
              render={(_value, order) => (
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`Убрать заказ ${order.fullNumber} из заявки`}
                  onClick={() => {
                    const { [order.lineOrderId]: _removed, ...rest } = edit.orders;
                    onChange({ ...edit, orders: rest });
                  }}
                />
              )}
            />
          )}
        </Table>
      )}
      {hiddenOrdersLabel(line.hiddenOrdersCount) && <div className="rr-sub" style={{ padding: '4px 12px' }}>{hiddenOrdersLabel(line.hiddenOrdersCount)} (учтено в остатке «на склад»)</div>}
      {(line.deletedOrdersCount ?? 0) > 0 && (
        <div className="rr-sub" style={{ padding: '4px 12px' }}>
          Заказов в корзине: {line.deletedOrdersCount} — {editable ? 'при сохранении черновика они будут убраны из заявки' : 'в «заказано» не учитываются'}
        </div>
      )}
    </div>
  );
}

interface OrderReceiptStatusProps {
  order: SupplierRequestLineOrderDto;
  unit: OnecUnitCode;
  /** «Возможные совпадения» показываются только для отправленных заявок. */
  showPossibleMatches: boolean;
  canManage: boolean;
  linkBusyKey: string | null;
  onLink: (match: SupplierRequestPossibleMatchDto, lineOrderId: number, quantity: number) => void;
  onUnlink: (receipt: SupplierRequestReceiptLinkDto) => void;
}

/** Ячейка «Приход» у заказа строки заявки (ф.3б): статус исполнения, привязанные приходы, возможные совпадения. */
function OrderReceiptStatus({ order, unit, showPossibleMatches, canManage, linkBusyKey, onLink, onUnlink }: OrderReceiptStatusProps) {
  const tag = fulfillmentTag(order.fulfillment);
  const receipts = order.receipts ?? [];
  const possibleMatches = showPossibleMatches ? order.possibleMatches ?? [] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
      <div>
        <span className={`rr-tag rr-tag--${tag.tone}`}>{tag.label}</span>{' '}
        <span className="rr-sub rr-num">пришло {formatRequestQuantity(order.fulfilled ?? 0, unit)} из {formatRequestQuantity(order.quantity, unit)}</span>
      </div>
      {receipts.map((receipt) => (
        <div key={receipt.linkId} className="rr-sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{receiptLineLabel(receipt, unit)}</span>
          {canManage && (
            <Button
              size="small"
              type="link"
              loading={linkBusyKey === `unlink:${receipt.linkId}`}
              disabled={linkBusyKey !== null && linkBusyKey !== `unlink:${receipt.linkId}`}
              onClick={() => onUnlink(receipt)}
            >
              Отвязать
            </Button>
          )}
        </div>
      ))}
      {possibleMatches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="rr-sub">Возможные совпадения:</span>
          {possibleMatches.map((match) => (
            <PossibleMatchRow
              // Ключ включает остатки: после соседней привязки строка пересоздаётся со свежим количеством (CR2-3).
              key={`${match.documentId}-${match.lineId}-${match.allocationId}-${match.suggestedQuantity}-${order.fulfilled}`}
              order={order}
              match={match}
              unit={unit}
              canManage={canManage}
              busy={linkBusyKey === `link:${match.documentId}:${match.lineId}:${match.allocationId}:${order.lineOrderId}`}
              disabled={linkBusyKey !== null && linkBusyKey !== `link:${match.documentId}:${match.lineId}:${match.allocationId}:${order.lineOrderId}`}
              onLink={(quantity) => onLink(match, order.lineOrderId, quantity)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PossibleMatchRowProps {
  order: SupplierRequestLineOrderDto;
  match: SupplierRequestPossibleMatchDto;
  unit: OnecUnitCode;
  canManage: boolean;
  busy: boolean;
  disabled: boolean;
  onLink: (quantity: number) => void;
}

/** Строка «возможного совпадения»: приход того же заказа/материала, не привязанный к заявке целиком. */
function PossibleMatchRow({ order, match, unit, canManage, busy, disabled, onLink }: PossibleMatchRowProps) {
  const max = possibleMatchMaxQuantity(order, match);
  const [quantity, setQuantity] = useState(() => possibleMatchDefaultQuantity(order, match));

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="rr-sub">
        {match.documentNumber} от {formatDate(match.documentDate)}
        {match.counterpartyName ? ` · ${match.counterpartyName}` : ''}
        {' · '}не привязано {formatRequestQuantity(match.unlinkedQuantity, unit)}
      </span>
      <InputNumber<number>
        size="small"
        min={0}
        max={max}
        precision={3}
        step={0.1}
        value={quantity}
        disabled={!canManage}
        aria-label={`Количество для привязки прихода ${match.documentNumber}`}
        onChange={(value) => setQuantity(Math.min(max, Math.max(0, value ?? 0)))}
      />
      <Tooltip title={match.supplierCheck === 'unknown' ? 'Поставщика прихода не удалось сверить с поставщиком заявки' : undefined}>
        <Button
          size="small"
          type={match.supplierCheck === 'unknown' ? 'default' : 'primary'}
          loading={busy}
          disabled={!canManage || disabled || quantity <= 0 || quantity > max}
          onClick={() => onLink(quantity)}
        >
          Привязать
        </Button>
      </Tooltip>
    </div>
  );
}

const TRANSITION_TITLES: Record<'send' | 'close' | 'cancel', string> = {
  send: 'Отправить заявку',
  close: 'Закрыть заявку',
  cancel: 'Отменить заявку',
};

const TRANSITION_SUCCESS: Record<'send' | 'close' | 'cancel', string> = {
  send: 'Заявка отправлена',
  close: 'Заявка закрыта',
  cancel: 'Заявка отменена',
};

const TRANSITION_CONTENTS: Record<'send' | 'close' | 'cancel', (card: SupplierRequestCardDto) => string> = {
  send: (card) => `Отправить заявку ${card.requestNumber} поставщику «${card.supplierName}»?`,
  close: (card) => `Закрыть заявку ${card.requestNumber}? Непокрытый остаток вернётся в рабочий список.`,
  cancel: (card) => `Отменить заявку ${card.requestNumber}? Позиции вернутся в рабочий список.`,
};

function confirmModal(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({ title, content, okText: 'Да', cancelText: 'Отмена', onOk: () => resolve(true), onCancel: () => resolve(false) });
  });
}

const EMPTY_LIST: SupplierRequestsListResponseDto['data'] = [];
