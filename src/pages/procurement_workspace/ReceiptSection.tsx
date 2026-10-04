import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { isApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import { procurementWorkspaceApi } from '../../api/procurementWorkspaceApi';
import type { OnecDocumentCardDto, OnecDocumentListItemDto } from '../../api/types/onecDocumentsApi.types';
import type { ProcurementWorklistLine } from '../../api/types/procurementWorkspaceApi.types';
import { Segmented } from '../../ui/Segmented';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import { OrderNumber } from '../order_resource_requirements/OrderNumber';
import { AllocationSuggestionPanel } from '../onec_purchase_documents/AllocationSuggestionPanel';
import { allocationStateLabel } from '../onec_purchase_documents/onecDocumentsHelpers';
import {
  RECEIPT_FILTERS,
  RECEIPT_FILTER_LABELS,
  buildAllocatedGroups,
  formatReceiptQuantity,
  lineSummaryText,
  matchesReceiptFilter,
  mergeReceiptPages,
  parseReceiptFilter,
  receiptListParams,
  receiptSupplier,
  shouldLoadNextReceipts,
  worklistForReceiptParams,
  type AllocatedLineGroup,
  type AllocatedOrderRow,
  type ReceiptListFilter,
} from './receiptHelpers';
import { formatQuantity } from './worklistHelpers';

export interface ReceiptSectionProps {
  /** Раздел виден: иначе без опроса сервера (та же логика, что у `WorklistSection`). */
  active: boolean;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** `pages` — сколько страниц уже подгружено в список; `more` — идёт подгрузка следующей. */
  | { status: 'ready'; data: OnecDocumentListItemDto[]; total: number; pages: number; more: boolean };

const RECEIPT_PARAM = 'receipt';
const FILTER_PARAM = 'receipts';
const STATE_TONES: Record<OnecDocumentListItemDto['allocationState'], string> = { none: 'bad', partial: 'warn', full: 'ok' };
/** Высота списка — примерно пять приходов, дальше прокрутка внутри контейнера. */
const LIST_SCROLL_Y = 250;

/**
 * «Приход 1С» на экране снабжения: сворачиваемый список приходов на всю ширину (состав и количества, фильтр по
 * распределению), блок «Распределено по заказам» выбранного прихода и тот же `AllocationSuggestionPanel`, что в
 * карточке документа 1С. Выбранный документ и фильтр — в адресе (`receipt=`, `receipts=`).
 */
export function ReceiptSection({ active }: ReceiptSectionProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseReceiptFilter(searchParams.get(FILTER_PARAM));
  /** До какой страницы список должен быть загружен: растёт при прокрутке до конца (следующая страница дописывается). */
  const [wantedPages, setWantedPages] = useState(1);
  const [listOpen, setListOpen] = useState(true);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  /** Старый backend не знает `allocation`/`withLines` — тогда прежний запрос и фильтр на клиенте. */
  const [legacy, setLegacy] = useState(false);
  const [revision, setRevision] = useState(0);

  // Полная перезагрузка (фильтр, после распределения): страницы 1..wanted читаются заново и заменяют список разом —
  // прежние строки остаются на экране до ответа, поэтому список не мигает и не прыгает.
  const wantedRef = useRef(wantedPages);
  wantedRef.current = wantedPages;
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    (async () => {
      try {
        if (legacy) {
          const response = await onecDocumentsApi.list(receiptListParams(filter, 1, true));
          const data = response.data.filter((document) => matchesReceiptFilter(document.allocationState, filter));
          if (alive) setState({ status: 'ready', data, total: data.length, pages: 1, more: false });
          return;
        }
        const target = wantedRef.current;
        let data: OnecDocumentListItemDto[] = [];
        let total = 0;
        for (let page = 1; page <= target; page += 1) {
          const response = await onecDocumentsApi.list(receiptListParams(filter, page));
          if (!alive) return;
          data = mergeReceiptPages(data, response.data);
          total = response.pagination.total;
          if (data.length >= total) break;
        }
        if (alive) setState({ status: 'ready', data, total, pages: target, more: false });
      } catch (error) {
        if (!alive) return;
        if (!legacy && isApiError(error, 'ONEC_DOCUMENTS_QUERY_INVALID')) { setLegacy(true); return; }
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить приходы 1С' });
      }
    })();
    return () => { alive = false; };
  }, [active, filter, legacy, revision]);

  // Прокрутка дошла до конца списка — подгружается и дописывается следующая страница (замечание 2026-10-04).
  useEffect(() => {
    if (!active || legacy || state.status !== 'ready' || state.pages >= wantedPages || state.more) return undefined;
    let alive = true;
    const nextPage = state.pages + 1;
    setState((current) => (current.status === 'ready' ? { ...current, more: true } : current));
    onecDocumentsApi.list(receiptListParams(filter, nextPage))
      .then((response) => {
        if (!alive) return;
        setState((current) => (current.status === 'ready'
          ? { status: 'ready', data: mergeReceiptPages(current.data, response.data), total: response.pagination.total, pages: nextPage, more: false }
          : current));
      })
      .catch(() => {
        // Подгрузка не удалась: список остаётся как есть, следующая прокрутка до конца попробует снова.
        if (alive) { setWantedPages(nextPage - 1); setState((current) => (current.status === 'ready' ? { ...current, more: false } : current)); }
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, legacy, wantedPages, state.status === 'ready' ? state.pages : 0]);
  const onListScroll = (event: UIEvent<HTMLDivElement>) => {
    const body = event.target as HTMLElement;
    if (!body.classList?.contains('ant-table-body') || state.status !== 'ready') return;
    if (shouldLoadNextReceipts({ scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight,
      loaded: state.data.length, total: state.total, busy: state.more || state.pages < wantedPages })) {
      setWantedPages(state.pages + 1);
    }
  };

  const documents = state.status === 'ready' ? state.data : EMPTY_DOCUMENTS;
  // Выбранный приход не зависит от фильтра списка: после распределения он уходит из «не распределённых», но остаётся открытым.
  const requestedId = Number(searchParams.get(RECEIPT_PARAM));
  const selectedId = Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : documents[0]?.documentId ?? null;

  useEffect(() => {
    if (state.status !== 'ready' || selectedId == null || requestedId === selectedId) return;
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set(RECEIPT_PARAM, String(selectedId));
      return params;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, selectedId]);

  const setParam = (key: string, value: string | null) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (value === null) params.delete(key); else params.set(key, value);
    return params;
  }, { replace: true });
  const changeFilter = (next: ReceiptListFilter) => { setWantedPages(1); setParam(FILTER_PARAM, next === 'open' ? null : next); };

  // Карточка выбранного прихода: заголовок и распределения по заказам.
  const [card, setCard] = useState<{ documentId: number; data: OnecDocumentCardDto } | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || selectedId == null) return undefined;
    let alive = true;
    setCardError(null);
    onecDocumentsApi.getCard(selectedId)
      .then((response) => { if (alive) setCard({ documentId: selectedId, data: response.data }); })
      .catch((error: unknown) => {
        if (alive) { setCard(null); setCardError(error instanceof Error ? error.message : 'Не удалось загрузить приход'); }
      });
    return () => { alive = false; };
  }, [active, revision, selectedId]);
  const selectedCard = card && card.documentId === selectedId ? card.data : null;

  // Экран не должен прыгать при выборе прихода и после «Распределить выбранное»: пока новые данные грузятся (панель
  // подбора показывает индикатор, блок «Распределено по заказам» ещё пуст), область под списком удерживает прежнюю
  // высоту; удержание снимается, когда и карточка, и панель загрузились.
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  const [panelSettled, setPanelSettled] = useState(false);
  const holdHeight = useCallback(() => {
    setHeldHeight(detailsRef.current?.offsetHeight ?? null);
    setPanelSettled(false);
  }, []);
  const onPanelSettled = useCallback(() => setPanelSettled(true), []);
  useEffect(() => {
    if (heldHeight !== null && panelSettled && (selectedCard !== null || cardError !== null)) setHeldHeight(null);
  }, [cardError, heldHeight, panelSettled, selectedCard]);
  const selectReceipt = (documentId: number) => {
    if (documentId === selectedId) return;
    holdHeight();
    setParam(RECEIPT_PARAM, String(documentId));
  };
  const hasAllocations = selectedCard?.lines.some((line) => line.allocations.length > 0 || line.hiddenAllocationsCount > 0) ?? false;

  // Потребность заказов этого прихода — из рабочего списка с фильтром «Документ 1С».
  const [demand, setDemand] = useState<{ documentId: number; lines: ProcurementWorklistLine[] } | null>(null);
  useEffect(() => {
    if (!active || selectedId == null || !hasAllocations) return undefined;
    let alive = true;
    procurementWorkspaceApi.worklist({ preset: 'all', onecDocumentId: selectedId })
      .then((response) => { if (alive) setDemand({ documentId: selectedId, lines: response.lines }); })
      .catch(() => { if (alive) setDemand({ documentId: selectedId, lines: [] }); });
    return () => { alive = false; };
  }, [active, hasAllocations, revision, selectedId]);
  const groups = useMemo(
    () => (selectedCard ? buildAllocatedGroups(selectedCard, demand && demand.documentId === selectedId ? demand.lines : []) : []),
    [demand, selectedCard, selectedId],
  );

  const selectedListItem = documents.find((document) => document.documentId === selectedId) ?? null;
  const header = selectedCard ?? selectedListItem;

  return (
    <div>
      <div className="rr-appbar">
        <span className="rr-ttl">
          {header ? `Поступление ${header.number} от ${formatDate(header.date)}` : 'Приход 1С: подобрать заказы'}
        </span>
        {header && <span className={`rr-tag rr-tag--${header.posted && !header.deletedInOnec ? 'ok' : 'warn'}`}>{header.posted && !header.deletedInOnec ? 'проведён' : 'не проведён'}</span>}
        {header && (
          <span className="rr-muted">{receiptSupplier(header)} · {allocationStateLabel(header.allocationState)}</span>
        )}
      </div>

      <div className="rr-receipts">
        <div className="rr-receipts-head">
          <Button
            type="text"
            size="small"
            icon={listOpen ? <DownOutlined /> : <RightOutlined />}
            aria-expanded={listOpen}
            onClick={() => setListOpen((value) => !value)}
          >
            Приходы 1С{state.status === 'ready' ? ` · ${state.total}` : ''}
          </Button>
          <span style={{ flex: 1 }} />
          <Segmented
            aria-label="Какие приходы показать"
            value={filter}
            onChange={(value) => changeFilter(value as ReceiptListFilter)}
            options={RECEIPT_FILTERS.map((value) => ({ value, label: RECEIPT_FILTER_LABELS[value] }))}
          />
        </div>
        {listOpen && state.status === 'error' && <div className="rr-pad"><Alert type="error" showIcon message={state.message} /></div>}
        {listOpen && state.status !== 'error' && (
          <div onScrollCapture={onListScroll}>
          <Table<OnecDocumentListItemDto>
            className="rr-table rr-receipts-table"
            size="small"
            rowKey="documentId"
            loading={state.status === 'loading'}
            dataSource={documents}
            scroll={{ y: LIST_SCROLL_Y }}
            pagination={false}
            rowClassName={(document) => (document.documentId === selectedId ? 'rr-receipt-row rr-receipt-row--picked' : 'rr-receipt-row')}
            onRow={(document) => ({ onClick: () => selectReceipt(document.documentId), 'aria-selected': document.documentId === selectedId })}
            locale={{ emptyText: filter === 'open' ? 'Не распределённых приходов нет' : 'Нет проведённых приходов' }}
            columns={[
              { title: 'Дата', key: 'date', width: 100, render: (_value, document) => <span className="rr-num">{formatDate(document.date)}</span> },
              { title: '№', key: 'number', width: 110, render: (_value, document) => <b>{document.number}</b> },
              { title: 'Поставщик', key: 'supplier', width: 220, render: (_value, document) => receiptSupplier(document) },
              {
                title: 'Что пришло',
                key: 'lines',
                render: (_value, document) => (document.lineSummary ? (
                  <div>
                    {document.lineSummary.map((line) => <div key={line.lineNo}>{lineSummaryText(line)}</div>)}
                    {(document.lineSummaryMore ?? 0) > 0 && <div className="rr-sub">+ ещё строк: {document.lineSummaryMore}</div>}
                  </div>
                ) : <span className="rr-muted">{document.linesCount} стр.</span>),
              },
              {
                title: 'Распределение',
                key: 'state',
                width: 170,
                render: (_value, document) => (
                  <span className={`rr-tag rr-tag--${STATE_TONES[document.allocationState]}`}>{allocationStateLabel(document.allocationState)}</span>
                ),
              },
              {
                title: 'Заказов',
                key: 'orders',
                width: 90,
                align: 'right',
                render: (_value, document) => document.orders.length + document.hiddenOrdersCount || '—',
              },
            ]}
          />
          </div>
        )}
        {listOpen && state.status === 'ready' && !legacy && state.total > 0 && (
          <div className="rr-receipts-foot">
            показано {state.data.length} из {state.total}{state.more ? ' · загружается…' : state.data.length < state.total ? ' · прокрутите до конца, чтобы показать ещё' : ''}
          </div>
        )}
      </div>

      {cardError && <div className="rr-pad"><Alert type="error" showIcon message={cardError} /></div>}
      {state.status === 'ready' && selectedId == null && (
        <div className="rr-pad"><div className="rr-hint-box">Проведённых приходов 1С пока нет — они появятся после загрузки документов из 1С.</div></div>
      )}

      <div ref={detailsRef} style={heldHeight === null ? undefined : { minHeight: heldHeight }}>
      {selectedId != null && groups.length > 0 && (
        <AllocatedOrders groups={groups} worklistSearch={worklistForReceiptParams(searchParams, selectedId).toString()} />
      )}

      {selectedId != null && (
        <AllocationSuggestionPanel
          key={`${selectedId}:${revision}`}
          documentId={selectedId}
          onDone={() => { holdHeight(); setRevision((value) => value + 1); }}
          onSettled={onPanelSettled}
        />
      )}
      </div>
    </div>
  );
}

/** «Распределено по заказам»: по строке прихода — заказы, их потребность и сколько обеспечено этим поступлением. */
function AllocatedOrders({ groups, worklistSearch }: { groups: AllocatedLineGroup[]; worklistSearch: string }) {
  return (
    <div className="rr-allocated">
      <div className="rr-allocated-head">
        <b>Распределено по заказам</b>
        <span style={{ flex: 1 }} />
        <Link to={{ search: worklistSearch }} replace>
          <Button size="small">Показать эти заказы в рабочем списке</Button>
        </Link>
      </div>
      {groups.map((group) => (
        <div key={group.lineId} className="rr-allocated-line">
          <div className="rr-allocated-title">
            <b>{group.name}</b>
            <span className="rr-muted rr-num">в документе {formatReceiptQuantity(group.documentQuantity, group.unitName)}</span>
          </div>
          {group.rows.length > 0 && (
            <Table<AllocatedOrderRow>
              size="small"
              rowKey="key"
              dataSource={group.rows}
              pagination={false}
              columns={[
                {
                  title: 'Заказ',
                  key: 'order',
                  render: (_value, row) => (
                    <Link to={`/order-resource-requirements/show/${row.orderId}`}>
                      <OrderNumber strong orderName={row.orderName} fullNumber={row.fullNumber ?? undefined} />
                    </Link>
                  ),
                },
                {
                  title: 'Потребность заказа',
                  key: 'need',
                  align: 'right',
                  width: 200,
                  render: (_value, row) => <span className="rr-num">{row.need !== null && row.needUnit ? formatQuantity(row.need, row.needUnit) : '—'}</span>,
                },
                {
                  title: 'Обеспечено из этого поступления',
                  key: 'quantity',
                  align: 'right',
                  width: 260,
                  render: (_value, row) => <b className="rr-num">{formatReceiptQuantity(row.quantity, group.unitName)}</b>,
                },
              ]}
            />
          )}
          <div className="rr-line-foot">
            <span className="rr-num">
              Итого по заказам <b>{formatReceiptQuantity(group.allocated, group.unitName)}</b> из {formatReceiptQuantity(group.documentQuantity, group.unitName)}
            </span>
            {group.hiddenAllocationsCount > 0 && <span className="rr-muted">в том числе заказы вне вашей области: {group.hiddenAllocationsCount}</span>}
            {group.exceeded
              ? <span className="rr-tag rr-tag--bad">больше, чем в документе, на {formatReceiptQuantity(-group.remaining, group.unitName)}</span>
              : group.remaining > 0
                ? <span className="rr-tag rr-tag--warn">не распределено {formatReceiptQuantity(group.remaining, group.unitName)}</span>
                : <span className="rr-tag rr-tag--ok">строка распределена полностью</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const EMPTY_DOCUMENTS: OnecDocumentListItemDto[] = [];
