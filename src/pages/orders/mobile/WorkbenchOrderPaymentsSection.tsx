import React, { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { DownOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { workbenchPaymentRows } from './workbenchOrderMobileModel';
import { useOrderOnecReceipts } from '../components/onec/useOrderOnecReceipts';
import { onecReceiptCardPath } from '../../payments/onecReceiptsAccess';
import { ONEC_RECEIPT_STATE_LABELS, onecReceiptKindLabel } from '../../payments/onecReceipts';
import { orderOnecAmountText, orderOnecStateNotes, orderOnecTruncatedText } from '../components/onec/orderOnecReceipts';

interface PaymentTypeRow {
  type_paid_id: number;
  type_paid_name: string;
}

export interface WorkbenchOrderPaymentsSectionProps {
  payments: readonly Record<string, unknown>[];
  /** Заказ: платежи 1С (только просмотр) — отметка у сверенного платежа и строки без сопоставления. */
  orderId?: number | null;
}

/** «Оплаты (N)» карточки заказа NewLine на телефоне (мокап 22): свёрнутый список, только чтение. */
export const WorkbenchOrderPaymentsSection: React.FC<WorkbenchOrderPaymentsSectionProps> = ({ payments, orderId = null }) => {
  const paymentsKey = payments.map((payment) => `${payment.payment_id}:${payment.amount}:${payment.payment_date}`).join(',');
  const onec = useOrderOnecReceipts(orderId, paymentsKey);
  const onecByPayment = onec.status === 'ready' ? onec.split.byPaymentId : null;
  const onecOther = onec.status === 'ready' ? onec.split.other : [];
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
            <div className="wb-msec__line wb-msec__line--empty">Платежей в приложении нет</div>
          ) : rows.map((row) => (
            <div key={row.key} className="wb-msec__line">
              <span>
                {row.label}
                {row.notes ? <small>{row.notes}</small> : null}
                {onecByPayment?.get(Number(row.key))?.map((line) => (
                  <small key={line.lineId}>1С: <Link to={onecReceiptCardPath(line.lineId)}>{onecReceiptKindLabel(line.kind)} {line.number}</Link></small>
                ))}
              </span>
              <b>{row.amount}</b>
            </div>
          ))}
          {onec.status === 'loading' ? (
            <div className="wb-msec__line wb-msec__line--empty">Платежи 1С загружаются…</div>
          ) : null}
          {onec.status === 'error' ? (
            <div className="wb-msec__line wb-msec__line--empty" role="alert">{onec.message}</div>
          ) : null}
          {onec.status === 'ready' && onec.truncated ? (
            <div className="wb-msec__line wb-msec__line--empty">{orderOnecTruncatedText(onec)}</div>
          ) : null}
          {onecOther.length > 0 ? (
            <div className="wb-msec__line wb-msec__line--empty">Платежи 1С без сопоставления ({onecOther.length})</div>
          ) : null}
          {onecOther.map((line) => (
            <div key={`onec-${line.lineId}`} className="wb-msec__line">
              <span>
                <Link to={onecReceiptCardPath(line.lineId)}>{onecReceiptKindLabel(line.kind)} {line.number}</Link>
                <small>{line.date.split('-').reverse().join('.')} · {ONEC_RECEIPT_STATE_LABELS[line.state]}</small>
                {orderOnecStateNotes(line).map((note) => <small key={note.kind}>{note.text}</small>)}
              </span>
              <b>{orderOnecAmountText(line)}</b>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
};
