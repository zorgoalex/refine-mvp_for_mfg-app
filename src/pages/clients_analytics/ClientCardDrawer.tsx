import { Tooltip } from '../../ui/tooltipDelay';
import React, { useEffect, useState } from 'react';
import { Drawer, Tabs } from 'antd';
import dayjs from 'dayjs';
import { useNavigation } from '@refinedev/core';
import { clientsAnalyticsApi, type ClientAnalyticsCard } from '../../api/clientsReadApi';
import { featureFlags } from '../../config/featureFlags';
import { formatNumber } from '../../utils/numberFormat';
import { clientCardView } from './clientsDashboard';
import '../payments_analytics/paymentsAnalytics.css';
import './clientsAnalytics.css';

const money = (value: number | string) => `${formatNumber(Number(value) || 0, 0)} ₸`;
const date = (value: string | null) => (value ? dayjs(value).format('DD.MM.YYYY') : '—');

type Loaded = { clientId: number; card: ClientAnalyticsCard | null };

/**
 * The analytics card of one client, sliding in from the right: who the client is, how they order and
 * pay, the last twelve months, and their latest orders and payments. Read-only; the numbers come from
 * the backend. `clientId === null` — the drawer is closed.
 */
export function ClientCardDrawer({ clientId, onClose }: { clientId: number | null; onClose: () => void }) {
  const { show } = useNavigation();
  const available = featureFlags.useBackendAuth && featureFlags.useBackendPermissions;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (clientId === null || !available) return undefined;
    let current = true;
    clientsAnalyticsApi.card(clientId)
      .then((card) => { if (current) setLoaded({ clientId, card }); })
      .catch(() => { if (current) setLoaded({ clientId, card: null }); });
    return () => { current = false; };
  }, [available, clientId]);

  const result = clientId !== null && loaded?.clientId === clientId ? loaded : null;
  const card = result?.card ?? null;
  const view = card ? clientCardView(card) : null;
  const state = !available ? 'карточка недоступна в этом режиме входа' : result ? 'не удалось загрузить (нет доступа или ошибка сервера)' : 'загрузка…';

  return (
    <Drawer
      className="ca-card"
      open={clientId !== null}
      onClose={onClose}
      width={720}
      destroyOnClose
      title={card ? (
        <div className="ca-card__title">
          <span className="ca-card__name">{card.client.clientName}</span>
          <span className="ca-card__tag">{card.client.personType === 'legal' ? 'Компания' : 'Физическое лицо'}</span>
          {view ? <span className="ca-card__tag" data-recency={view.recency.segment}>{view.recency.label}</span> : null}
          {!card.client.isActive ? <span className="ca-card__tag" data-muted>Неактивен</span> : null}
        </div>
      ) : 'Клиент'}
    >
      {!card || !view ? <div className="pa-dash__state">{state}</div> : (
        <div className="ca-card__body">
          <div className="ca-card__lead">
            <div className="ca-card__summary">{view.summary}</div>
            <div className="ca-card__contacts">
              {card.client.phones.length === 0 ? <span className="ca-card__muted">телефон не указан</span> : card.client.phones.map((phone) => (
                <a key={phone.phone} href={`tel:${phone.phone.replace(/[^+\d]/g, '')}`} data-primary={phone.isPrimary ? 'true' : undefined}>{phone.phone}</a>
              ))}
              <span className="ca-card__muted">клиент с {date(card.client.createdAt)}</span>
              <a onClick={() => show('clients', card.client.clientId, 'push')}>открыть клиента</a>
            </div>
            {card.client.notes ? <div className="ca-card__notes">{card.client.notes}</div> : null}
          </div>

          <section className="ca-card__money" aria-label="Деньги клиента">
            <div>
              <div className="pa-summary__label">Заказано</div>
              <div className="ca-card__big">{money(view.amount)}</div>
              <div className="pa-summary__hint">средний чек {view.averageOrder === null ? '—' : money(view.averageOrder)}</div>
            </div>
            <div>
              <div className="pa-summary__label">Оплачено</div>
              <div className="ca-card__big">{money(view.paid)}</div>
              <div className="ca-card__paid" title={`Оплачено ${Math.round(view.paidShare * 100)}% заказанного`}><i style={{ width: `${view.paidShare * 100}%` }} /></div>
              <div className="pa-summary__hint">{Math.round(view.paidShare * 100)}% заказанного · {card.totals.payments} платежей</div>
            </div>
            <div>
              <div className="pa-summary__label">{view.debt < 0 ? 'Переплата' : 'Долг'}</div>
              <div className={`ca-card__big${view.debt > 0 ? ' ca-card__big--bad' : ''}`}>{money(Math.abs(view.debt))}</div>
              <div className="pa-summary__hint">
                {view.debt > 0 ? 'заказано больше, чем оплачено' : view.debt < 0 ? 'оплачено больше, чем заказано' : 'заказано и оплачено поровну'}
              </div>
            </div>
          </section>

          <dl className="ca-card__facts">
            <div><dt>Заказов</dt><dd>{card.totals.orders}{card.totals.ordersInProgress > 0 ? <small> · {card.totals.ordersInProgress} в работе</small> : null}</dd></div>
            <div><dt>Первый заказ</dt><dd>{date(card.totals.firstOrderDate)}</dd></div>
            <div><dt>Последний заказ</dt><dd>{date(card.totals.lastOrderDate)}</dd></div>
            <div><dt>Как часто</dt><dd>{card.totals.averageIntervalDays === null ? '—' : `раз в ${card.totals.averageIntervalDays} дн.`}</dd></div>
            <div><dt>Последний платёж</dt><dd>{date(card.totals.lastPaymentDate)}</dd></div>
            <div><dt>Скидки</dt><dd>{money(card.totals.discount)}</dd></div>
            <div><dt>Площадь</dt><dd>{formatNumber(Number(card.totals.area) || 0, 2)} м²</dd></div>
            <div><dt>Деталей</dt><dd>{formatNumber(card.totals.parts, 0)}</dd></div>
          </dl>

          <section className="ca-card__section">
            <h4>Заказы по месяцам <span>последние 12 месяцев · сумма заказов</span></h4>
            <div className="ca-months" role="img" aria-label="Сумма заказов по месяцам">
              {view.months.map((month) => (
                <Tooltip key={month.key} title={`${month.label} ${month.key.slice(0, 4)}: ${money(month.amount)} · ${month.orders} зак. · оплачено ${money(month.paid)}`}>
                  <div className="ca-months__col" data-empty={month.amount === 0 ? 'true' : undefined}>
                    <div className="ca-months__track"><i style={{ height: `${month.amount > 0 ? Math.max(4, month.share * 100) : 0}%` }} /></div>
                    <div className="ca-months__label">{month.label}</div>
                    <div className="ca-months__count">{month.orders > 0 ? month.orders : ''}</div>
                    <div className="ca-months__year">{month.year ?? ''}</div>
                  </div>
                </Tooltip>
              ))}
            </div>
            <div className="ca-dash__legend">Под месяцем — число заказов.</div>
          </section>

          {view.paymentTypes.length > 0 ? (
            <section className="ca-card__section">
              <h4>Как платит <span>за всё время</span></h4>
              <ul className="pa-rows ca-card__types">
                {view.paymentTypes.map((type, index) => (
                  <li key={type.name}>
                    <span className="pa-rows__name"><i data-tone={['a', 'b', 'c', 'd', 'e'][index % 5]} />{type.name}</span>
                    <span className="pa-rows__bar"><i data-tone={['a', 'b', 'c', 'd', 'e'][index % 5]} style={{ width: `${type.share * 100}%` }} /></span>
                    <b>{money(type.amount)}</b>
                    <span className="pa-rows__note">{Math.round(type.share * 100)}% · {type.count} пл.</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Tabs
            className="ca-card__tabs"
            items={[
              {
                key: 'orders',
                label: `Заказы · ${card.totals.orders}`,
                children: card.orders.length === 0 ? <div className="pa-dash__state">заказов нет</div> : (
                  <>
                    <table className="pa-debtors ca-table ca-card__table">
                      <thead><tr><th>Заказ</th><th>Дата</th><th>Статус</th><th>Сумма</th><th>Оплачено</th><th>Долг</th></tr></thead>
                      <tbody>
                        {card.orders.map((order) => (
                          <tr key={order.orderId}>
                            <td><a onClick={() => show('orders_view', order.orderId, 'push')}>№ {order.orderName}</a></td>
                            <td>{date(order.orderDate)}</td>
                            <td className="ca-card__status">{order.statusName ?? '—'}{order.paymentStatusName ? <small>{order.paymentStatusName}</small> : null}</td>
                            <td>{money(order.amount)}</td>
                            <td>{money(order.paid)}</td>
                            <td>{Number(order.debt) > 0 ? <b>{money(order.debt)}</b> : <span className="ca-card__muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {card.totals.orders > card.orders.length ? <div className="ca-dash__legend">Показаны последние {card.orders.length} из {card.totals.orders}.</div> : null}
                  </>
                ),
              },
              {
                key: 'payments',
                label: `Платежи · ${card.totals.payments}`,
                children: card.payments.length === 0 ? <div className="pa-dash__state">платежей нет</div> : (
                  <>
                    <table className="pa-debtors ca-table ca-card__table ca-card__table--payments">
                      <thead><tr><th>Дата</th><th>Заказ</th><th>Способ</th><th>Сумма</th></tr></thead>
                      <tbody>
                        {card.payments.map((payment) => (
                          <tr key={payment.paymentId}>
                            <td>{date(payment.paymentDate)}</td>
                            <td><a onClick={() => show('orders_view', payment.orderId, 'push')}>№ {payment.orderName}</a></td>
                            <td>{payment.typePaidName ?? '—'}</td>
                            <td><b>{money(payment.amount)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {card.totals.payments > card.payments.length ? <div className="ca-dash__legend">Показаны последние {card.payments.length} из {card.totals.payments}.</div> : null}
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
    </Drawer>
  );
}
