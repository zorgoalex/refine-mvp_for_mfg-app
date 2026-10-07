// Order Dates Section
// Contains: Planned Completion Date, Completion Date, Issue Date

import React, { useEffect, useState } from 'react';
import { Form, DatePicker, Row, Col } from 'antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import dayjs from 'dayjs';
import { useOptionalUiVariant } from '../../../../ui-variant/UiVariantProvider';
import { ordersApi } from '../../../../api/ordersApi';
import { authSession } from '../../../../api/authSession';
import { featureFlags } from '../../../../config/featureFlags';
import { canSeeDayLoad, dayLoadText, deadlineRelativeText, quickDeadlineOptions } from './orderFormWorkbench';

const DAY_LOAD_PAGE_SIZE = 200;

/** «NewLine»: сколько заказов и какая площадь уже стоят в плане на выбранную дату. */
const useDayLoadText = (date: string | null, enabled: boolean): string => {
  const [state, setState] = useState<{ date: string; text: string } | null>(null);
  useEffect(() => {
    if (!enabled || !date) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      ordersApi
        .list({ plannedCompletionDateFrom: date as any, plannedCompletionDateTo: date as any, page: 1, pageSize: DAY_LOAD_PAGE_SIZE })
        .then((response) => {
          if (cancelled) return;
          const area = response.data.reduce((sum, order) => sum + (Number(order.totalArea) || 0), 0);
          const total = response.pagination.total;
          setState({ date, text: dayLoadText(date, total, area, total > response.data.length) });
        })
        .catch(() => { if (!cancelled) setState(null); }); // подсказка необязательна
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [date, enabled]);
  return enabled && state && state.date === date ? state.text : '';
};

interface OrderDatesSectionProps {
  /** обычный срок по настройкам сроков, если он известен (создание заказа) */
  usualPlannedDate?: string | null;
}

export const OrderDatesSection: React.FC<OrderDatesSectionProps> = ({ usualPlannedDate = null }) => {
  const { header, updateHeaderField } = useOrderFormStore();
  const isWorkbench = useOptionalUiVariant()?.variant === 'workbench';
  const plannedDate = typeof header.planned_completion_date === 'string' && header.planned_completion_date
    ? String(header.planned_completion_date).slice(0, 10)
    : null;
  const dayLoad = useDayLoadText(
    plannedDate,
    isWorkbench && canSeeDayLoad(authSession.getUser() as any, featureFlags),
  );
  const quickOptions = isWorkbench
    ? quickDeadlineOptions(header.order_date ? String(header.order_date) : null, usualPlannedDate)
    : [];
  const relative = isWorkbench ? deadlineRelativeText(plannedDate, dayjs().format('YYYY-MM-DD')) : '';

  return (
    <Form layout="vertical" className="order-dates-form">
      <Row gutter={16}>
        <Col span={8} className="order-dates-form__planned">
          <Form.Item label="Плановая дата завершения">
            <DatePicker
              value={header.planned_completion_date ? dayjs(header.planned_completion_date) : null}
              onChange={(date) =>
                updateHeaderField('planned_completion_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>

        {isWorkbench ? (
          <Col className="order-dates-form__quick">
            {relative ? <span className="wb-form-deadline__relative">{relative}</span> : null}
            <span className="wb-form-deadline__chips">
              {quickOptions.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  className="wb-form-deadline__chip"
                  aria-pressed={plannedDate === option.date}
                  title={`Срок ${dayjs(option.date).format('DD.MM.YYYY')} — ${option.days} дн. от даты заказа`}
                  onClick={() => updateHeaderField('planned_completion_date', option.date)}
                >
                  +{option.days} дн.{option.usual ? ' · обычно' : ''}
                </button>
              ))}
            </span>
            {dayLoad ? <span className="wb-form-deadline__load">{dayLoad}</span> : null}
          </Col>
        ) : null}

        <Col span={8} className="order-dates-form__fact">
          <Form.Item label="Дата завершения">
            <DatePicker
              value={header.completion_date ? dayjs(header.completion_date) : null}
              onChange={(date) =>
                updateHeaderField('completion_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>

        <Col span={8} className="order-dates-form__fact">
          <Form.Item label="Дата выдачи">
            <DatePicker
              value={header.issue_date ? dayjs(header.issue_date) : null}
              onChange={(date) =>
                updateHeaderField('issue_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
};
