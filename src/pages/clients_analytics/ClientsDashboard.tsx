import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { clientsAnalyticsApi, type ClientPersonTypeCode } from '../../api/clientsReadApi';
import { DateBarsChart } from '../../components/analytics/DateBarsChart';
import { GRAIN_TEXT, barGrain } from '../../components/analytics/dateBars';
import { featureFlags } from '../../config/featureFlags';
import { formatNumber } from '../../utils/numberFormat';
import {
  CLIENTS_DASHBOARD_PERIODS,
  clientsDashboardRange,
  clientsDashboardView,
  type ClientsDashboardPeriod,
  type ClientsDashboardView,
} from './clientsDashboard';
import '../payments_analytics/paymentsAnalytics.css';
import './clientsAnalytics.css';

const money = (value: number) => `${formatNumber(value, 0)} ₸`;
const percent = (share: number | null) => (share === null ? '—' : `${Math.round(share * 100)}%`);
const PERSON_TYPES: ReadonlyArray<{ key: 'all' | ClientPersonTypeCode; label: string }> = [
  { key: 'all', label: 'Все клиенты' },
  { key: 'individual', label: 'Физические лица' },
  { key: 'legal', label: 'Компании' },
];

type Loaded = { key: string; view: ClientsDashboardView | null };

/**
 * «+Клиенты → Дашборд»: how many clients are new and how many buy, orders and revenue over the
 * period, who the clients are (by recency, by number of orders, by person type), the largest clients
 * of the period and the sleeping ones worth calling back. All numbers come from the backend.
 */
export function ClientsDashboard({ onOpenClient }: { onOpenClient: (clientId: number) => void }) {
  const [period, setPeriod] = useState<ClientsDashboardPeriod>(90);
  const [personType, setPersonType] = useState<'all' | ClientPersonTypeCode>('all');
  const today = dayjs().format('YYYY-MM-DD');
  const range = useMemo(() => clientsDashboardRange(period, today), [period, today]);
  const key = `${range.dateFrom}:${range.dateTo}:${personType}`;
  // the backend knows only a backend session
  const available = featureFlags.useBackendAuth && featureFlags.useBackendPermissions;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!available) return undefined;
    let current = true;
    clientsAnalyticsApi.dashboard({ ...range, ...(personType === 'all' ? {} : { personType }) })
      .then((response) => { if (current) setLoaded({ key, view: clientsDashboardView(response) }); })
      .catch(() => { if (current) setLoaded({ key, view: null }); });
    return () => { current = false; };
  }, [available, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = loaded?.key === key ? loaded : null;
  const view = result?.view ?? null;
  const state = !available ? 'дашборд недоступен в этом режиме входа' : result ? 'не удалось загрузить (нет доступа или ошибка сервера)' : 'загрузка…';
  const grain = view ? GRAIN_TEXT[barGrain(view.days.length)] : '';

  return (
    <div className="pa-dash ca-dash" aria-busy={available && result === null}>
      <div className="pa-dash__bar">
        <div className="pa-dash__periods" role="group" aria-label="Период дашборда">
          {CLIENTS_DASHBOARD_PERIODS.map((days) => (
            <button key={days} type="button" className="pa-dash__period" aria-pressed={period === days} onClick={() => setPeriod(days)}>
              {days === 365 ? 'Год' : `${days} дней`}
            </button>
          ))}
        </div>
        <div className="pa-dash__periods" role="group" aria-label="Тип клиентов">
          {PERSON_TYPES.map((type) => (
            <button key={type.key} type="button" className="pa-dash__period" aria-pressed={personType === type.key} onClick={() => setPersonType(type.key)}>
              {type.label}
            </button>
          ))}
        </div>
        <span className="pa-dash__range">{dayjs(range.dateFrom).format('DD.MM.YYYY')} – {dayjs(range.dateTo).format('DD.MM.YYYY')}</span>
      </div>

      {!view ? <div className="pa-dash__state">{state}</div> : (
        <>
          <section className="pa-summary ca-summary--five" aria-label="Показатели периода">
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Клиентов в базе</div>
              <div className="pa-summary__value">{formatNumber(view.clients, 0)}</div>
              <div className="pa-summary__hint">новых за период: <b>{formatNumber(view.newClients, 0)}</b></div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Заказывали за период</div>
              <div className="pa-summary__value">{formatNumber(view.buyers, 0)}</div>
              <div className="pa-summary__hint">из них повторных: <b>{formatNumber(view.repeatBuyers, 0)}</b> ({percent(view.repeatShare)})</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Заказов и выручка</div>
              <div className="pa-summary__value">{formatNumber(view.amount, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">{formatNumber(view.orders, 0)} заказов · оплачено {money(view.paid)}</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Средний чек</div>
              <div className="pa-summary__value">{view.averageOrder === null ? '—' : formatNumber(view.averageOrder, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">на один заказ</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Выручка на клиента</div>
              <div className="pa-summary__value">{view.averagePerBuyer === null ? '—' : formatNumber(view.averagePerBuyer, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">среди заказывавших за период</div>
            </div>
          </section>

          <div className="pa-dash__two">
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Выручка по заказам</h3><span>{grain} · по дате заказа</span></header>
              <DateBarsChart
                days={view.days.map((day) => ({ date: day.date, value: day.amount, count: day.orders }))}
                formatValue={money}
                unit="зак."
                ariaLabel="Выручка по заказам"
              />
            </section>
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Новые клиенты</h3><span>{grain} · по дате заведения</span></header>
              <DateBarsChart
                days={view.days.map((day) => ({ date: day.date, value: day.newClients }))}
                formatValue={(value) => `${formatNumber(value, 0)} кл.`}
                tone="c"
                ariaLabel="Новые клиенты"
              />
            </section>
          </div>

          <div className="pa-dash__two">
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Кто когда заказывал</h3><span>вся база на сегодня · выручка за всё время</span></header>
              <ul className="pa-rows ca-rows">
                {view.recency.map((row) => (
                  <li key={row.segment} title={row.hint}>
                    <span className="pa-rows__name"><i data-recency={row.segment} />{row.label}</span>
                    <span className="pa-rows__bar"><i data-recency={row.segment} style={{ width: `${row.share * 100}%` }} /></span>
                    <b>{formatNumber(row.clients, 0)} кл.</b>
                    <span className="pa-rows__note">{percent(row.share)} · {money(row.amount)}</span>
                  </li>
                ))}
              </ul>
              <div className="ca-dash__legend">Активные — заказ за 90 дней, спящие — 91–365 дней, потерянные — больше года.</div>
            </section>
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Сколько заказов делают клиенты</h3><span>за всё время · доля клиентов и доля выручки</span></header>
              <ul className="pa-rows ca-rows ca-rows--double">
                {view.frequency.map((row) => (
                  <li key={row.bucket}>
                    <span className="pa-rows__name">{row.label}</span>
                    <span className="ca-rows__pair">
                      <span className="pa-rows__bar" title="Доля клиентов"><i data-tone="a" style={{ width: `${row.clientShare * 100}%` }} /></span>
                      <span className="pa-rows__bar" title="Доля выручки"><i data-tone="c" style={{ width: `${row.amountShare * 100}%` }} /></span>
                    </span>
                    <b>{formatNumber(row.clients, 0)} кл.</b>
                    <span className="pa-rows__note">{percent(row.clientShare)} кл. · {percent(row.amountShare)} выручки</span>
                  </li>
                ))}
              </ul>
              <div className="ca-dash__legend"><i data-tone="a" /> доля клиентов <i data-tone="c" /> доля выручки</div>
              {view.personTypes.length > 0 ? (
                <ul className="pa-rows ca-rows ca-rows--types">
                  {view.personTypes.map((type) => (
                    <li key={type.label}>
                      <span className="pa-rows__name">{type.label}</span>
                      <span className="pa-rows__bar"><i data-tone="d" style={{ width: `${type.share * 100}%` }} /></span>
                      <b>{money(type.amount)}</b>
                      <span className="pa-rows__note">{type.buyers} кл. · {type.orders} зак. за период</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>

          <div className="pa-dash__two">
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Крупнейшие клиенты периода</h3><span>по сумме заказов</span></header>
              {view.top.length === 0 ? <div className="pa-dash__state">за период заказов нет</div> : (
                <table className="pa-debtors ca-table">
                  <thead><tr><th>Клиент</th><th>Заказов</th><th>Последний</th><th>Сумма</th></tr></thead>
                  <tbody>
                    {view.top.map((client) => (
                      <tr key={client.clientId}>
                        <td><a onClick={() => onOpenClient(client.clientId)}>{client.clientName}</a></td>
                        <td>{client.orders}</td>
                        <td>{dayjs(client.lastOrderDate).format('DD.MM.YYYY')}</td>
                        <td><b>{money(Number(client.amount) || 0)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Кому позвонить</h3><span>спящие клиенты с самой большой выручкой за всё время</span></header>
              {view.reactivate.length === 0 ? <div className="pa-dash__state">спящих клиентов нет</div> : (
                <table className="pa-debtors ca-table">
                  <thead><tr><th>Клиент</th><th>Телефон</th><th>Не заказывал</th><th>Выручка</th></tr></thead>
                  <tbody>
                    {view.reactivate.map((client) => (
                      <tr key={client.clientId}>
                        <td><a onClick={() => onOpenClient(client.clientId)}>{client.clientName}</a></td>
                        <td>{client.phone ?? '—'}</td>
                        <td>{client.daysSince} дн.</td>
                        <td><b>{money(Number(client.amount) || 0)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
