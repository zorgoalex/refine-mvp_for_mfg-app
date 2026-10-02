// «NewLine» order card: right column cards. Display only — every value comes from
// data the card already shows elsewhere (header, «Дополнительная информация», groups).
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { message } from 'antd';
import { Tooltip } from '../../../../ui/tooltipDelay';
import {
  CopyOutlined,
  PhoneOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useList } from '../../../../query/orderLifecycleQueries';
import { orderDeadlineHint } from '../../orderListWorkbench';

const formatPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  if (digits.length === 10) return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
  return phone;
};

const initials = (name: string): string => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase() ?? '')
  .join('');

export const WorkbenchSideCard: React.FC<React.PropsWithChildren<{
  title: string;
  extra?: React.ReactNode;
  className?: string;
}>> = ({ title, extra, className, children }) => (
  <section className={`wb-panel wb-side-card${className ? ` ${className}` : ''}`}>
    <div className="wb-side-card__head">
      <h2>{title}</h2>
      {extra ? <div className="wb-side-card__extra">{extra}</div> : null}
    </div>
    <div className="wb-side-card__body">{children}</div>
  </section>
);

export const OrderClientCard: React.FC<{
  clientId?: number | null;
  clientName?: string | null;
  canViewClients: boolean;
}> = ({ clientId, clientName, canViewClients }) => {
  const { data: phonesData } = useList({
    resource: 'client_phones',
    filters: [{ field: 'client_id', operator: 'eq', value: clientId }],
    pagination: { pageSize: 100 },
    queryOptions: { enabled: !!clientId && canViewClients },
  });
  const phones = useMemo(() => {
    const rows = [...(phonesData?.data || [])] as any[];
    rows.sort((left, right) => Number(Boolean(right.is_primary)) - Number(Boolean(left.is_primary)));
    return rows.filter((row) => typeof row.phone_number === 'string' && row.phone_number.trim());
  }, [phonesData]);
  const name = clientName || '—';

  return (
    <WorkbenchSideCard
      title="Клиент"
      extra={clientId && canViewClients ? <Link className="wb-side-card__link" to={`/clients/show/${clientId}`}>Карточка</Link> : null}
    >
      <div className="wb-side-row wb-side-row--lead">
        <span className="wb-avatar" aria-hidden>{initials(name) || '—'}</span>
        <b className="wb-side-row__strong">{name}</b>
      </div>
      {phones.length === 0 ? (
        <div className="wb-side-row wb-side-row--muted"><PhoneOutlined aria-hidden />Телефон не указан</div>
      ) : phones.map((phone) => {
        const formatted = formatPhone(phone.phone_number);
        return (
          <div className="wb-side-row" key={phone.phone_id ?? phone.phone_number}>
            <PhoneOutlined aria-hidden />
            <a href={`tel:${String(phone.phone_number).replace(/[^+\d]/g, '')}`}>{formatted}</a>
            {phone.is_primary ? <small>основной</small> : null}
            <span className="wb-side-row__spacer" />
            <Tooltip title="Скопировать номер">
              <button
                type="button"
                className="wb-icon-btn"
                aria-label={`Скопировать номер ${formatted}`}
                onClick={() => {
                  void navigator.clipboard?.writeText(String(phone.phone_number))
                    .then(() => message.success('Номер скопирован'))
                    .catch(() => message.error('Не удалось скопировать номер'));
                }}
              >
                <CopyOutlined />
              </button>
            </Tooltip>
          </div>
        );
      })}
    </WorkbenchSideCard>
  );
};

const formatDate = (value?: string | Date | null) => (value ? dayjs(value).format('DD.MM.YYYY') : '—');

export const OrderDatesCard: React.FC<{ record: any }> = ({ record }) => {
  const hint = orderDeadlineHint(record ?? {});
  const rows: Array<{ key: string; label: React.ReactNode; value?: string | null; done: boolean; strong?: boolean }> = [
    { key: 'order', label: 'Заказ оформлен', value: record?.order_date, done: Boolean(record?.order_date) },
    {
      key: 'planned',
      label: (
        <>
          <b>Плановое выполнение</b>
          {hint && !record?.completion_date && !record?.issue_date ? <span data-tone={hint.tone}> · {hint.text}</span> : null}
        </>
      ),
      value: record?.planned_completion_date,
      done: false,
      strong: true,
    },
    { key: 'completion', label: 'Завершение', value: record?.completion_date, done: Boolean(record?.completion_date) },
    { key: 'issue', label: 'Выдача', value: record?.issue_date, done: Boolean(record?.issue_date) },
    { key: 'payment', label: 'Оплата', value: record?.payment_date, done: Boolean(record?.payment_date) },
  ];

  return (
    <WorkbenchSideCard title="Сроки">
      <div className="wb-dates">
        {rows.map((row) => (
          <React.Fragment key={row.key}>
            <span className="wb-dates__icon" data-done={row.done} data-strong={row.strong === true}>
              {row.done ? <CheckCircleOutlined aria-hidden /> : <ClockCircleOutlined aria-hidden />}
            </span>
            <span className="wb-dates__label">{row.label}</span>
            <span className="wb-dates__value" data-strong={row.strong === true}>{formatDate(row.value)}</span>
          </React.Fragment>
        ))}
      </div>
    </WorkbenchSideCard>
  );
};

export interface OrderLinkItem {
  key: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  to?: string | null;
  hint?: React.ReactNode;
  title?: string;
}

export const OrderLinksCard: React.FC<{ items: OrderLinkItem[] }> = ({ items }) => (
  <WorkbenchSideCard title="Связи" className="wb-side-card--links">
    {items.length === 0 ? (
      <div className="wb-side-row wb-side-row--muted">Связанных объектов нет</div>
    ) : items.map((item) => {
      const content = (
        <>
          <span className="wb-link-row__icon" aria-hidden>{item.icon}</span>
          <span className="wb-link-row__label">{item.label}</span>
          {item.hint ? <small>{item.hint}</small> : null}
        </>
      );
      return item.to ? (
        <Link key={item.key} className="wb-link-row" to={item.to} title={item.title}>{content}</Link>
      ) : (
        <div key={item.key} className="wb-link-row wb-link-row--static" title={item.title}>{content}</div>
      );
    })}
  </WorkbenchSideCard>
);

export const OrderNotesCard: React.FC<{ notes?: string | null; extra?: React.ReactNode }> = ({ notes, extra }) => (
  <WorkbenchSideCard title="Примечание" extra={extra}>
    <div className={`wb-notes${notes ? '' : ' wb-notes--empty'}`}>{notes || 'Примечания нет'}</div>
  </WorkbenchSideCard>
);
