// «NewLine»: нижняя панель формы заказа — состояние, итог и те же «Закрыть / Сохранить», что в шапке.
import React, { useMemo } from 'react';
import { Button } from 'antd';
import { CloseOutlined, SaveOutlined } from '@ant-design/icons';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { orderFormTotals } from './orderFormWorkbench';

// тиын показываем только когда они есть
export const orderFormMoney = (value: number): string => (
  `${formatNumber(value, Math.abs(value * 100 - Math.round(value) * 100) < 0.5 ? 0 : 2)} ${CURRENCY_SYMBOL}`
);

interface Props {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export const OrderFormWorkbenchBar: React.FC<Props> = ({ dirty, saving, onSave, onCancel }) => {
  const { header, details, payments, catalogLines } = useOrderFormStore();
  const totals = useMemo(
    () => orderFormTotals({ header, details, payments, catalogLines }),
    [header, details, payments, catalogLines],
  );
  return (
    <div className="wb-form-savebar" role="region" aria-label="Сохранение заказа">
      <span className="wb-form-savebar__state" data-dirty={dirty}>{dirty ? 'Не сохранено' : 'Изменений нет'}</span>
      <span className="wb-form-savebar__fact">
        {totals.parts} дет. · <b>{formatNumber(totals.area, 2)} м²</b>
      </span>
      <span className="wb-form-savebar__fact">
        Итого <b className="wb-form-savebar__total">{orderFormMoney(totals.finalAmount)}</b>
      </span>
      {totals.remainingAmount > 0 && totals.paidAmount > 0 ? (
        <span className="wb-form-savebar__fact">остаток <b>{orderFormMoney(totals.remainingAmount)}</b></span>
      ) : null}
      <span className="wb-form-savebar__spacer" />
      <Button icon={<CloseOutlined />} onClick={onCancel} disabled={saving}>Закрыть</Button>
      <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving} disabled={!dirty}>
        Сохранить
        <kbd className="wb-form-savebar__kbd">Ctrl S</kbd>
      </Button>
    </div>
  );
};
