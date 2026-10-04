import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button } from 'antd';
import { useEffect, useMemo, useState } from 'react';
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
  RECEIPT_PAGE_SIZE,
  buildAllocatedGroups,
  formatReceiptQuantity,
  lineSummaryText,
  matchesReceiptFilter,
  parseReceiptFilter,
  receiptListParams,
  receiptSupplier,
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
  | { status: 'ready'; data: OnecDocumentListItemDto[]; total: number };

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
  const [page, setPage] = useState(1);
  const [listOpen, setListOpen] = useState(true);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  /** Старый backend не знает `allocation`/`withLines` — тогда прежний запрос и фильтр на клиенте. */
  const [legacy, setLegacy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    onecDocumentsApi.list(receiptListParams(filter, page, legacy))
      .then((response) => {
        if (!alive) return;
        const data = legacy ? response.data.filter((document) => matchesReceiptFilter(document.allocationState, filter)) : response.data;
        setState({ status: 'ready', data, total: legacy ? data.length : response.pagination.total });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (!legacy && isApiError(error, 'ONEC_DOCUMENTS_QUERY_INVALID')) { setLegacy(true); return; }
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить приходы 1С' });
      });
    return () => { alive = false; };
  }, [active, filter, legacy, page, revision]);

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
  const changeFilter = (next: ReceiptListFilter) => { setPage(1); setParam(FILTER_PARAM, next === 'open' ? null : next); };

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
          <Table<OnecDocumentListItemDto>
            className="rr-table rr-receipts-table"
            size="small"
            rowKey="documentId"
            loading={state.status === 'loading'}
            dataSource={documents}
            scroll={{ y: LIST_SCROLL_Y }}
            pagination={legacy ? false : {
              current: page, onChange: setPage, pageSize: RECEIPT_PAGE_SIZE, total: state.status === 'ready' ? state.total : 0,
              showSizeChanger: false, hideOnSinglePage: true, size: 'small', style: { padding: '0 16px' },
            }}
            rowClassName={(document) => (document.documentId === selectedId ? 'ant-table-row-selected rr-receipt-row' : 'rr-receipt-row')}
            onRow={(document) => ({ onClick: () => setParam(RECEIPT_PARAM, String(document.documentId)) })}
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
        )}
      </div>

      {cardError && <div className="rr-pad"><Alert type="error" showIcon message={cardError} /></div>}
      {state.status === 'ready' && selectedId == null && (
        <div className="rr-pad"><div className="rr-hint-box">Проведённых приходов 1С пока нет — они появятся после загрузки документов из 1С.</div></div>
      )}

      {selectedId != null && groups.length > 0 && (
        <AllocatedOrders groups={groups} worklistSearch={worklistForReceiptParams(searchParams, selectedId).toString()} />
      )}

      {selectedId != null && (
        <AllocationSuggestionPanel
          key={`${selectedId}:${revision}`}
          documentId={selectedId}
          onDone={() => setRevision((value) => value + 1)}
        />
      )}
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
