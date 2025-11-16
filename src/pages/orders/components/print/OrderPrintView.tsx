import React, { useMemo, forwardRef } from 'react';
import { formatNumber, formatDate, getYearLastTwoDigits, formatArea, formatPrice } from '../../../../utils/printFormat';
import './OrderPrintView.css';

/**
 * Интерфейс для детали заказа
 */
interface OrderDetail {
  detail_id: number;
  length: number | null;
  width: number | null;
  quantity: number;
  area: number | null;
  notes: string | null;
  milling_cost_per_sqm: number | null;
  detail_cost: number | null;
  milling_type?: { milling_type_name: string } | null;
  edge_type?: { edge_type_name: string } | null;
  film?: { film_name: string } | null;
}

/**
 * Интерфейс для заказа
 */
interface Order {
  order_id: number;
  order_name: string;
  order_date: string | Date;
  total_amount: number | null;
  discounted_amount: number | null;
  paid_amount: number | null;
  parts_count: number | null;
  total_area: number | null;
  notes: string | null;
}

/**
 * Интерфейс для клиента
 */
interface Client {
  client_name: string;
}

/**
 * Пропсы компонента печати
 */
interface OrderPrintViewProps {
  order: Order;
  details: OrderDetail[];
  client?: Client;
}

/**
 * Компонент для печати карточки заказа
 * Визуально максимально похож на Excel шаблон
 */
export const OrderPrintView = forwardRef<HTMLDivElement, OrderPrintViewProps>(
  ({ order, details, client }, ref) => {
    // Расчеты
    const yearLastTwo = useMemo(
      () => getYearLastTwoDigits(order.order_date),
      [order.order_date]
    );

    const totalArea = useMemo(
      () => details.reduce((sum, d) => sum + (d.area || 0), 0),
      [details]
    );

    const partsCount = useMemo(() => details.length, [details]);

    const totalAmount = order.discounted_amount || order.total_amount || 0;
    const paidAmount = order.paid_amount || 0;
    const remainingAmount = totalAmount - paidAmount;

    // Первая деталь для дополнительных полей (defaults)
    const firstDetail = details[0];

    return (
      <div ref={ref} className="order-print-view">
        {/* Шапка заказа */}
        <div className="print-header">
          <div className="print-row header-row-1">
            <div className="cell cell-year">{yearLastTwo}</div>
            <div className="cell cell-empty-narrow"></div>
            <div className="cell cell-order-id">{order.order_id}</div>
            <div className="cell cell-attachment red-text">№ присадки</div>
            <div className="cell cell-customer-label">Заказчик</div>
            <div className="cell cell-total-label">общая сумма</div>
          </div>

          <div className="print-row header-row-2">
            <div className="cell cell-empty-narrow"></div>
            <div className="cell cell-empty-narrow"></div>
            <div className="cell cell-empty-narrow"></div>
            <div className="cell cell-empty-narrow"></div>
            <div className="cell cell-customer-name">{client?.client_name || 'Не указан'}</div>
            <div className="cell cell-total-sum">{formatPrice(totalAmount)} KZT</div>
          </div>
        </div>

        {/* Дополнительные поля (строка 5) */}
        <div className="additional-fields">
          <div className="print-row">
            <div className="cell label">фрезеровка</div>
            <div className="cell value">{firstDetail?.milling_type?.milling_type_name || ''}</div>
            <div className="cell"></div>
            <div className="cell label">обкат</div>
            <div className="cell value">{firstDetail?.edge_type?.edge_type_name || ''}</div>
            <div className="cell label">пленка</div>
            <div className="cell value">{firstDetail?.film?.film_name || ''}</div>
            <div className="cell"></div>
            <div className="cell"></div>
            <div className="cell"></div>
            <div className="cell label">остаток оплаты</div>
            <div className="cell value">{formatPrice(remainingAmount)} KZT</div>
            <div className="cell"></div>
          </div>
        </div>

        {/* Информация о заказе (строка 8) */}
        <div className="order-info">
          <div className="print-row">
            <div className="cell date-label">Дата</div>
            <div className="cell date-value">{formatDate(order.order_date)}</div>
            {order.notes && <div className="cell notes-value">{order.notes}</div>}
            <div className="cell spacer"></div>
            <div className="cell area-label">общая площадь</div>
            <div className="cell area-value">{formatArea(totalArea)}</div>
            <div className="cell parts-label">кол-во<br/>деталей</div>
            <div className="cell parts-value">{partsCount}</div>
          </div>
        </div>

        {/* Таблица деталей */}
        <table className="details-table">
          <thead>
            <tr>
              <th className="col-num">№</th>
              <th className="col-height">Высота</th>
              <th className="col-width">Ширина</th>
              <th className="col-qty vertical-text">Кол-во</th>
              <th className="col-area">м²</th>
              <th className="col-type">Тип детали</th>
              <th className="col-edge vertical-text">Обкат</th>
              <th className="col-note highlight">Примечание</th>
              <th className="col-price">Цена за кв.м.</th>
              <th className="col-sum">Сумма</th>
              <th className="col-film highlight">Пленка</th>
            </tr>
          </thead>
          <tbody>
            {details.map((detail, idx) => (
              <tr key={detail.detail_id || idx}>
                <td className="col-num">{idx + 1}</td>
                <td className="col-height">{detail.length || ''}</td>
                <td className="col-width">{detail.width || ''}</td>
                <td className="col-qty">{detail.quantity}</td>
                <td className="col-area">{formatArea(detail.area)}</td>
                <td className="col-type">{detail.milling_type?.milling_type_name || ''}</td>
                <td className="col-edge">{detail.edge_type?.edge_type_name || ''}</td>
                <td className="col-note">{detail.notes || ''}</td>
                <td className="col-price">{formatPrice(detail.milling_cost_per_sqm)}</td>
                <td className="col-sum">{formatPrice(detail.detail_cost)}</td>
                <td className="col-film">{detail.film?.film_name || ''}</td>
              </tr>
            ))}

            {/* Пустые строки для заполнения (до 40 строк) */}
            {Array.from({ length: Math.max(0, 40 - details.length) }).map((_, idx) => (
              <tr key={`empty-${idx}`} className="empty-row">
                <td className="col-num">{details.length + idx + 1}</td>
                <td className="col-height"></td>
                <td className="col-width"></td>
                <td className="col-qty"></td>
                <td className="col-area">0,00</td>
                <td className="col-type"></td>
                <td className="col-edge"></td>
                <td className="col-note"></td>
                <td className="col-price"></td>
                <td className="col-sum">0</td>
                <td className="col-film"></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Футер */}
        <div className="print-footer">
          <p className="note-1">
            С техническими и технологическими особенностями ознакомлен, количество и размеры верны (фамилия)
          </p>
          <p className="note-2">
            При отсутствии размеров фрезеровки от заказчика все размеры на усмотрение исполнителя заказа (подпись)
          </p>
          <p className="note-3">
            Техникалық және технологиялық ерекшеліктерімен таныстым, саны және өлшемі дұрыс
          </p>
        </div>

        {/* Водяной знак */}
        <div className="watermark">Страница</div>
      </div>
    );
  }
);

OrderPrintView.displayName = 'OrderPrintView';
