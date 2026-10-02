// «NewLine» order card: «История» — a collapsed spoiler in «Дополнительная информация».
// Everyone who can open the order sees its history (GET /orders/:id/history — allow-listed
// events as a closed projection: what happened, when, who, which status). Users with
// `audit.view` keep the richer journal source (GET /audit, scope=business) with «было → стало».
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { auditApi } from '../../../../api/auditApi';
import { ordersApi, type OrderHistoryEvent } from '../../../../api/ordersApi';
import type { AuditLogEventDto } from '../../../../api/types/auditApi.types';
import { can } from '../../../../utils/permissions';
import { auditEventTitle } from '../../../audit/eventLabels';
import { buildAuditReadableSummary } from '../../../audit/readableSummary';

const PAGE_SIZE = 20;

interface OrderHistorySpoilerProps {
  orderId: number;
}

interface HistoryRow {
  key: string;
  createdAt: string;
  title: string;
  actor: string;
  object: string;
  changes: Array<{ label: string; before: string; after: string }>;
  notes: string[];
}

function rowFromJournal(event: AuditLogEventDto): HistoryRow {
  const summary = buildAuditReadableSummary(event);
  return {
    key: event.auditId,
    createdAt: event.createdAt,
    title: summary.title,
    actor: summary.actor,
    object: summary.object,
    changes: summary.changes,
    notes: summary.notes,
  };
}

export function rowFromProjection(event: OrderHistoryEvent): HistoryRow {
  return {
    key: event.auditId,
    createdAt: event.createdAt,
    title: auditEventTitle(event.event),
    actor: event.actorName || 'Система',
    object: '',
    // the projection carries the resulting status only; values «было → стало» stay in the journal
    changes: event.statusName
      ? [{ label: event.statusField === 'paymentStatus' ? 'Статус оплаты' : 'Статус', before: '', after: event.statusName }]
      : [],
    notes: [],
  };
}

export const OrderHistorySpoiler: React.FC<OrderHistorySpoilerProps> = ({ orderId }) => {
  // the journal is chosen by the actual right; without it (whatever the permission flag) the order history is read
  const journalAccess = can('audit.view');
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadPage = useCallback(async (nextPage: number) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = journalAccess
        ? await auditApi.list({ scope: 'business', orderIds: [orderId], page: nextPage, pageSize: PAGE_SIZE })
            .then((response) => ({ rows: response.data.map(rowFromJournal), total: response.pagination.total }))
        : await ordersApi.history(orderId, { page: nextPage, pageSize: PAGE_SIZE })
            .then((response) => ({ rows: response.data.map(rowFromProjection), total: response.pagination.total }));
      if (requestRef.current !== requestId) return;
      setEvents((current) => (nextPage === 1 ? loaded.rows : [...current, ...loaded.rows]));
      setTotal(loaded.total);
      setPage(nextPage);
    } catch {
      if (requestRef.current !== requestId) return;
      setError('Не удалось загрузить историю заказа');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [journalAccess, orderId]);

  // another order in the same tab: drop what was loaded for the previous one
  useEffect(() => {
    requestRef.current += 1;
    setEvents([]);
    setTotal(null);
    setPage(0);
    setError(null);
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    if (open && page === 0 && !loading && !error) void loadPage(1);
  }, [error, loadPage, loading, open, page]);

  return (
    <section className={`order-history${open ? ' order-history--open' : ''}`}>
      <button
        type="button"
        className="order-history__summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <RightOutlined className="order-history__chevron" aria-hidden />
        <span className="order-history__title">История</span>
        {total != null ? <span className="order-history__count">{total}</span> : null}
      </button>
      {open ? (
        <div className="order-history__body">
          {error ? (
            <div className="order-history__note order-history__note--error">
              {error}
              <Button size="small" onClick={() => void loadPage(page === 0 ? 1 : page + 1)}>Повторить</Button>
            </div>
          ) : null}
          {!error && !loading && total === 0 ? (
            <div className="order-history__note">Записей истории по заказу нет</div>
          ) : null}
          {events.length > 0 ? (
            <ol className="order-history__list">
              {events.map((summary) => {
                return (
                  <li key={summary.key} className="order-history__item">
                    <span className="order-history__time">{dayjs(summary.createdAt).format('DD.MM.YYYY HH:mm')}</span>
                    <div className="order-history__event">
                      <div className="order-history__head">
                        <b>{summary.title}</b>
                        <span>{summary.actor}</span>
                        {summary.object ? <span>{summary.object}</span> : null}
                      </div>
                      {summary.changes.map((change, index) => (
                        <div className="order-history__change" key={`${change.label}-${index}`}>
                          <span>{change.label}:</span>
                          {change.before && change.before !== '—' ? <s>{change.before}</s> : null}
                          <b>{change.after || '—'}</b>
                        </div>
                      ))}
                      {summary.notes.length > 0 ? (
                        <div className="order-history__notes">{summary.notes.join(' · ')}</div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {loading ? <div className="order-history__note">Загрузка истории…</div> : null}
          {!loading && !error && total != null && events.length < total ? (
            <Button size="small" onClick={() => void loadPage(page + 1)}>
              Показать ещё ({total - events.length})
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
