import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { useNavigation } from '@refinedev/core';
import { paymentsAnalyticsApi } from '../../api/paymentsAnalyticsApi';
import { DateBarsChart } from '../../components/analytics/DateBarsChart';
import { GRAIN_TEXT, barGrain } from '../../components/analytics/dateBars';
import { featureFlags } from '../../config/featureFlags';
import { formatNumber } from '../../utils/numberFormat';
import { DASHBOARD_PERIODS, dashboardRange, dashboardView, type DashboardPeriod, type DashboardView } from './paymentsDashboard';
import './paymentsAnalytics.css';

const TONES = ['a', 'b', 'c', 'd', 'e'] as const;
const money = (value: number) => `${formatNumber(value, 0)} ₸`;

type Loaded = { key: string; view: DashboardView | null };

/**
 * «+Платежи → Дашборд»: what came in over the period by day and by payment type, refunds, and the
 * receivables (handed-over orders that are not fully paid) by age with the largest debtors.
 * All numbers are counted by the backend, which also checks the analytics right.
 */
export function PaymentsDashboard() {
  const { show } = useNavigation();
  const [period, setPeriod] = useState<DashboardPeriod>(30);
  const today = dayjs().format('YYYY-MM-DD');
  const range = useMemo(() => dashboardRange(period, today), [period, today]);
  const key = `${range.dateFrom}:${range.dateTo}`;
  // the backend knows only a backend session (see the summary panel)
  const available = featureFlags.useBackendAuth && featureFlags.useBackendPermissions;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!available) return undefined;
    let current = true;
    paymentsAnalyticsApi.dashboard(range)
      .then((response) => { if (current) setLoaded({ key, view: dashboardView(response) }); })
      .catch(() => { if (current) setLoaded({ key, view: null }); });
    return () => { current = false; };
  }, [available, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = loaded?.key === key ? loaded : null;
  const view = result?.view ?? null;
  const state = !available ? 'дашборд недоступен в этом режиме входа' : result ? 'не удалось загрузить' : 'загрузка…';

  return (
    <div className="pa-dash" aria-busy={available && result === null}>
      <div className="pa-dash__bar">
        <div className="pa-dash__periods" role="group" aria-label="Период дашборда">
          {DASHBOARD_PERIODS.map((days) => (
            <button key={days} type="button" className="pa-dash__period" aria-pressed={period === days} onClick={() => setPeriod(days)}>
              {days} дней
            </button>
          ))}
        </div>
        <span className="pa-dash__range">{dayjs(range.dateFrom).format('DD.MM.YYYY')} – {dayjs(range.dateTo).format('DD.MM.YYYY')}</span>
      </div>

      {!view ? <div className="pa-dash__state">{state}</div> : (
        <>
          <section className="pa-summary pa-summary--four" aria-label="Показатели периода">
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Поступило за {period} дней</div>
              <div className="pa-summary__value">{formatNumber(view.received, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">{formatNumber(view.receivedCount, 0)} платежей</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Возвраты</div>
              <div className={`pa-summary__value${view.refunds < 0 ? ' pa-summary__value--bad' : ''}`}>{formatNumber(view.refunds, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">{formatNumber(view.refundsCount, 0)} возвратов</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Средний платёж</div>
              <div className="pa-summary__value">{view.average === null ? '—' : formatNumber(view.average, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">без возвратов</div>
            </div>
            <div className="pa-summary__tile">
              <div className="pa-summary__label">Дебиторка</div>
              <div className="pa-summary__value">{formatNumber(view.receivables, 0)} <small>₸</small></div>
              <div className="pa-summary__hint">по {formatNumber(view.receivableOrders, 0)} выданным заказам</div>
            </div>
          </section>

          <section className="pa-panel">
            <header className="pa-panel__head"><h3>Поступления</h3><span>{GRAIN_TEXT[barGrain(view.days.length)]} · {period} дней</span></header>
            <DateBarsChart
              days={view.days.map((day) => ({ date: day.date, value: day.amount, count: day.count }))}
              formatValue={money}
              unit="пл."
              ariaLabel="Поступления"
            />
          </section>

          <div className="pa-dash__two">
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Структура по способам</h3><span>за {period} дней</span></header>
              {view.types.length === 0 ? <div className="pa-dash__state">за период платежей нет</div> : (
                <ul className="pa-rows">
                  {view.types.map((type, index) => (
                    <li key={type.name}>
                      <span className="pa-rows__name"><i data-tone={TONES[index % TONES.length]} />{type.name}</span>
                      <span className="pa-rows__bar"><i data-tone={TONES[index % TONES.length]} style={{ width: `${type.share * 100}%` }} /></span>
                      <b>{money(type.amount)}</b>
                      <span className="pa-rows__note">{Math.round(type.share * 100)}% · {type.count} пл.</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="pa-panel">
              <header className="pa-panel__head"><h3>Дебиторка по возрасту долга</h3><span>выданные и завершённые заказы за год без полной оплаты, от даты заказа</span></header>
              {view.receivableOrders === 0 ? <div className="pa-dash__state">неоплаченных выданных заказов нет</div> : (
                <ul className="pa-rows">
                  {view.ages.map((age) => (
                    <li key={age.bucket}>
                      <span className="pa-rows__name">{age.label}</span>
                      <span className="pa-rows__bar"><i data-age={age.bucket} style={{ width: `${age.share * 100}%` }} /></span>
                      <b>{money(age.amount)}</b>
                      <span className="pa-rows__note">{age.orders} зак.</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="pa-panel">
            <header className="pa-panel__head"><h3>Крупнейшие должники</h3><span>{view.debtors.length > 0 ? `первые ${view.debtors.length} по сумме долга` : ''}</span></header>
            {view.debtors.length === 0 ? <div className="pa-dash__state">должников нет</div> : (
              <table className="pa-debtors">
                <thead><tr><th>Клиент</th><th>Заказов</th><th>Самый старый</th><th>Долг</th></tr></thead>
                <tbody>
                  {view.debtors.map((debtor) => (
                    <tr key={debtor.clientId}>
                      <td><a onClick={() => show('clients_analytics_view', debtor.clientId, 'push')}>{debtor.clientName}</a></td>
                      <td>{debtor.orders}</td>
                      <td>{dayjs(debtor.oldestOrderDate).format('DD.MM.YYYY')}</td>
                      <td><b>{money(Number(debtor.amount) || 0)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
