import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { paymentsAnalyticsApi } from '../../api/paymentsAnalyticsApi';
import { featureFlags } from '../../config/featureFlags';
import { formatNumber } from '../../utils/numberFormat';
import {
  SUMMARY_DEFAULT_DAYS,
  SUMMARY_MAX_DAYS,
  summarize,
  summaryScope,
  type AnalyticsFilter,
  type PaymentsSummary,
  type SummaryDay,
} from './paymentsAnalyticsSummary';
import './paymentsAnalytics.css';

const PART_TONES = ['a', 'b', 'c', 'd', 'e'] as const;
const NO_DAYS: Record<string, SummaryDay> = {};
const formatDay = (value: string) => dayjs(value).format('DD.MM.YYYY');

type Loaded = { key: string; summary: PaymentsSummary | null; failed: boolean };

/**
 * Totals of the analytics screen for the list's current filters: what came in, how it splits by
 * payment type, the average payment. Reports the per-day totals up so the table can mark each day.
 * A result is shown only for the scope it was requested for: while another period or filter is
 * loading (or has failed) the tiles say so instead of keeping the previous numbers.
 */
export function PaymentsAnalyticsSummaryPanel({
  filters,
  onDays,
}: {
  filters: readonly AnalyticsFilter[] | undefined;
  onDays?: (days: Record<string, SummaryDay>) => void;
}) {
  const today = dayjs().format('YYYY-MM-DD');
  const filtersKey = JSON.stringify(filters ?? []);
  const scope = useMemo(() => summaryScope(filters, today), [filtersKey, today]); // eslint-disable-line react-hooks/exhaustive-deps
  // The totals come from the backend, which knows only a backend session: under the legacy login a
  // request would be refused and the refusal would end the user's session. Then there are no totals.
  const backendSession = featureFlags.useBackendAuth && featureFlags.useBackendPermissions;
  const request = backendSession ? scope.params : null;
  const scopeKey = JSON.stringify(request);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!request) return undefined;
    let current = true;
    paymentsAnalyticsApi.summary(request)
      .then((response) => { if (current) setLoaded({ key: scopeKey, summary: summarize(response), failed: false }); })
      .catch(() => { if (current) setLoaded({ key: scopeKey, summary: null, failed: true }); });
    return () => { current = false; };
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // only the answer to the CURRENT scope counts
  const result = request && loaded?.key === scopeKey ? loaded : null;
  const summary = result?.summary ?? null;
  const days = summary?.days ?? NO_DAYS;
  useEffect(() => { onDays?.(days); }, [days, onDays]);

  const waiting = !backendSession
    ? 'итоги недоступны в этом режиме входа'
    : scope.problem === 'period_too_long'
    ? `период длиннее ${SUMMARY_MAX_DAYS} дней — сузьте его, чтобы увидеть итоги`
    : scope.problem === 'unsupported_filter'
      ? 'итоги не считаются для такого набора фильтров'
      : result?.failed ? 'не удалось загрузить' : 'загрузка…';
  const period = `${formatDay(scope.from)} – ${formatDay(scope.to)}`;
  return (
    <section className="pa-summary" aria-label="Итоги за период" aria-busy={request !== null && result === null}>
      <div className="pa-summary__tile">
        <div className="pa-summary__label">Поступило</div>
        <div className="pa-summary__value">{summary ? formatNumber(summary.amount, 0) : '—'} <small>₸</small></div>
        <div className="pa-summary__hint">
          {summary ? `${formatNumber(summary.count, 0)} платежей` : waiting}
          {' · '}{period}{scope.defaulted ? ` (последние ${SUMMARY_DEFAULT_DAYS} дней)` : ''}
        </div>
      </div>
      <div className="pa-summary__tile pa-summary__tile--wide">
        <div className="pa-summary__label">Структура по способам оплаты</div>
        {summary && summary.parts.length > 0 ? (
          <>
            <div className="pa-summary__bar" role="img" aria-label="Доли способов оплаты">
              {summary.parts.map((part, index) => (
                <i key={part.name} data-tone={PART_TONES[index % PART_TONES.length]} style={{ width: `${part.share * 100}%` }} />
              ))}
            </div>
            <ul className="pa-summary__legend">
              {summary.parts.map((part, index) => (
                <li key={part.name}>
                  <i data-tone={PART_TONES[index % PART_TONES.length]} />
                  <span>{part.name}</span>
                  <b>{formatNumber(part.amount, 0)} ₸</b>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="pa-summary__hint">{summary ? 'за период платежей нет' : waiting}</div>
        )}
      </div>
      <div className="pa-summary__tile">
        <div className="pa-summary__label">Средний платёж</div>
        <div className="pa-summary__value">{summary && summary.count > 0 ? formatNumber(summary.amount / summary.count, 0) : '—'} <small>₸</small></div>
        <div className="pa-summary__hint">{summary ? `по ${formatNumber(summary.count, 0)} платежам периода` : waiting}</div>
      </div>
    </section>
  );
}
