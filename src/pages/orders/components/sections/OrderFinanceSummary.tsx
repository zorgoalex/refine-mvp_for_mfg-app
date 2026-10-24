// «NewLine»: итоговая колонка раздела «Финансы» — из чего складывается сумма заказа и сколько осталось.
import React, { useMemo } from 'react';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { orderFormTotals } from './orderFormWorkbench';
import { orderFormMoney } from './OrderFormWorkbenchBar';

export const OrderFinanceSummary: React.FC = () => {
  const { header, details, payments, catalogLines } = useOrderFormStore();
  const totals = useMemo(
    () => orderFormTotals({ header, details, payments, catalogLines }),
    [header, details, payments, catalogLines],
  );
  const percent = (value: number) => (
    totals.totalAmount > 0 ? ` ${formatNumber((value / totals.totalAmount) * 100, 1).replace(/[,.]0$/, '')}%` : ''
  );
  return (
    <dl className="wb-form-finance__summary" aria-label="Итог заказа">
      <div><dt>Детали · {formatNumber(totals.area, 2)} м²</dt><dd>{orderFormMoney(totals.detailsAmount)}</dd></div>
      <div><dt>Услуги и товары</dt><dd>{orderFormMoney(totals.catalogAmount)}</dd></div>
      {totals.discount > 0 ? (
        <div data-tone="good"><dt>Скидка{percent(totals.discount)}</dt><dd>−{orderFormMoney(totals.discount)}</dd></div>
      ) : null}
      {totals.surcharge > 0 ? (
        <div><dt>Наценка{percent(totals.surcharge)}</dt><dd>+{orderFormMoney(totals.surcharge)}</dd></div>
      ) : null}
      <div className="wb-form-finance__total"><dt>Итого</dt><dd>{orderFormMoney(totals.finalAmount)}</dd></div>
      <div><dt>Оплачено</dt><dd>{orderFormMoney(totals.paidAmount)}</dd></div>
      <div data-tone={totals.remainingAmount > 0 ? 'warn' : 'good'}>
        <dt>Остаток к оплате</dt><dd>{orderFormMoney(totals.remainingAmount)}</dd>
      </div>
    </dl>
  );
};
