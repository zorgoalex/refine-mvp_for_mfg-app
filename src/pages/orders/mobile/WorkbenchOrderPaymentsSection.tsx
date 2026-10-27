import React, { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { DownOutlined } from '@ant-design/icons';
import { workbenchPaymentRows } from './workbenchOrderMobileModel';

interface PaymentTypeRow {
  type_paid_id: number;
  type_paid_name: string;
}

export interface WorkbenchOrderPaymentsSectionProps {
  payments: readonly Record<string, unknown>[];
}

/** «Оплаты (N)» карточки заказа NewLine на телефоне (мокап 22): свёрнутый список, только чтение. */
export const WorkbenchOrderPaymentsSection: React.FC<WorkbenchOrderPaymentsSectionProps> = ({ payments }) => {
  const { data: typesData } = useList<PaymentTypeRow>({
    resource: 'payment_types',
    pagination: { pageSize: 100 },
    queryOptions: { enabled: payments.length > 0 },
  });
  const typeNames = useMemo(
    () => new Map((typesData?.data ?? []).map((type) => [type.type_paid_id, type.type_paid_name])),
    [typesData],
  );
  const rows = useMemo(() => workbenchPaymentRows(payments, typeNames), [payments, typeNames]);

  return (
    <section className="wb-panel wb-msec" aria-label="Оплаты заказа">
      <details>
        <summary>
          Оплаты<span className="wb-msec__count">({rows.length})</span>
          <DownOutlined className="wb-msec__chevron" aria-hidden />
        </summary>
        <div className="wb-msec__body">
          {rows.length === 0 ? (
            <div className="wb-msec__line wb-msec__line--empty">Платежей нет</div>
          ) : rows.map((row) => (
            <div key={row.key} className="wb-msec__line">
              <span>
                {row.label}
                {row.notes ? <small>{row.notes}</small> : null}
              </span>
              <b>{row.amount}</b>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
};
