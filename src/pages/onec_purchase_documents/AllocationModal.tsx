import { useEffect, useMemo, useRef, useState } from 'react';
import { InputNumber, Modal, Select, Space, Spin, Typography, message } from 'antd';

import { ApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import { ordersApi } from '../../api/ordersApi';
import type { OnecDocumentCardDto, OnecDocumentLineDto, OnecDocumentsTab } from '../../api/types/onecDocumentsApi.types';
import type { OrderListItemDto, OrderResourceCardLineDto } from '../../api/types/orderApi.types';
import {
  defaultPaymentAllocationAmount,
  defaultReceiptAllocationQuantity,
  onecAllocationErrorMessage,
  onecUnitLabel, currencySymbol, isOrderCardCurrent } from './onecDocumentsHelpers';

export interface AllocationModalProps {
  open: boolean;
  document: OnecDocumentCardDto;
  line: OnecDocumentLineDto;
  tab: OnecDocumentsTab;
  onClose: () => void;
  /** Успешное распределение: родитель закрывает модалку и перечитывает карточку документа. */
  onSuccess: () => void;
}

interface OrderCardState {
  /** Заказ, для которого загружены строки; null — ничего не загружено. */
  orderId: number | null;
  loading: boolean;
  error: string | null;
  lines: OrderResourceCardLineDto[];
}

const EMPTY_ORDER_CARD_STATE: OrderCardState = { orderId: null, loading: false, error: null, lines: [] };

/**
 * «+ Заказ»: выбрать заказ, затем — для прихода строка материала уже задана
 * номенклатурой документа; для оплаты пользователь выбирает материал заказа,
 * на который относится оплата. Версию и отпечаток потребности берём из
 * актуальной карточки потребностей выбранного заказа, не из документа.
 */
export function AllocationModal({ open, document, line, tab, onClose, onSuccess }: AllocationModalProps) {
  const isReceipt = tab === 'receipts';
  const [orderSearch, setOrderSearch] = useState('');
  const [orders, setOrders] = useState<OrderListItemDto[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | undefined>(undefined);
  const [selectedOrder, setSelectedOrder] = useState<OrderListItemDto | undefined>(undefined);
  const [orderCard, setOrderCard] = useState<OrderCardState>(EMPTY_ORDER_CARD_STATE);
  const [resourceKey, setResourceKey] = useState<string | undefined>(undefined);
  const [measure, setMeasure] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Номер запроса карточки: поздний ответ по прежнему заказу не подменяет выбранный (R2).
  const cardRequestRef = useRef(0);
  const selectedOrderRef = useRef<number | undefined>(undefined);
  selectedOrderRef.current = selectedOrderId;

  // Сброс формы при каждом открытии модалки под новую строку документа.
  useEffect(() => {
    if (!open) return;
    setOrderSearch('');
    setOrders([]);
    setSelectedOrderId(undefined);
    setSelectedOrder(undefined);
    setOrderCard(EMPTY_ORDER_CARD_STATE);
    setResourceKey(isReceipt ? line.material?.resourceKey : undefined);
    setMeasure(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line.lineId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setOrdersLoading(true);
      try {
        const response = await ordersApi.list({
          search: orderSearch.trim() || undefined,
          pageSize: 50,
          sortBy: 'orderDate',
          sortOrder: 'desc',
        });
        if (!cancelled) setOrders(response.data);
      } catch (error) {
        if (!cancelled) message.error(error instanceof Error ? error.message : 'Не удалось загрузить список заказов');
      } finally {
        if (!cancelled) setOrdersLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, orderSearch]);

  const loadOrderCard = async (orderId: number) => {
    const requestId = cardRequestRef.current + 1;
    cardRequestRef.current = requestId;
    setOrderCard({ orderId: null, loading: true, error: null, lines: [] });
    try {
      const response = await ordersApi.getResourceDemandCard(orderId);
      if (cardRequestRef.current !== requestId || response.data.orderId !== orderId) return;
      setOrderCard({ orderId, loading: false, error: null, lines: response.data.lines });
    } catch (error) {
      if (cardRequestRef.current !== requestId) return;
      setOrderCard({
        orderId: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Не удалось загрузить потребности заказа',
        lines: [],
      });
    }
  };

  const handleOrderChange = (value: number | undefined) => {
    setSelectedOrderId(value);
    setSelectedOrder([selectedOrder, ...orders].find((order) => order?.orderId === value));
    cardRequestRef.current += 1;
    setOrderCard(EMPTY_ORDER_CARD_STATE);
    if (!isReceipt) setResourceKey(undefined);
    setMeasure(null);
    if (value != null) void loadOrderCard(value);
  };

  const demandLine = useMemo(
    () => orderCard.lines.find((candidate) => candidate.resourceKey === resourceKey),
    [orderCard.lines, resourceKey],
  );

  // Приход: количество по умолчанию — меньшее из остатка строки документа и потребности заказа.
  // Оплата: сумма по умолчанию — весь остаток строки.
  useEffect(() => {
    if (measure != null || !demandLine) return;
    const nextDefault = isReceipt
      ? defaultReceiptAllocationQuantity(line.remaining, demandLine.quantity)
      : defaultPaymentAllocationAmount(line.remaining);
    if (nextDefault != null) setMeasure(nextDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demandLine]);

  // Отправка — только когда загружена карточка именно выбранного заказа: иначе версия и
  // отпечаток потребности были бы от другого заказа.
  const cardReady = isOrderCardCurrent(orderCard.orderId, orderCard.loading, selectedOrderId);
  const canSubmit = selectedOrderId != null && cardReady && resourceKey != null && measure != null && measure > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || selectedOrderId == null || resourceKey == null || measure == null) return;
    setSubmitting(true);
    try {
      await onecDocumentsApi.addAllocation(document.documentId, line.lineId, {
        orderId: selectedOrderId,
        resourceKey,
        ...(isReceipt ? { quantity: measure } : { amount: measure }),
        expectedVersion: demandLine?.procurement.version ?? 0,
        expectedDemandFingerprint: demandLine?.demandFingerprint ?? '',
      });
      message.success('Строка распределена на заказ');
      onSuccess();
    } catch (error) {
      message.error(onecAllocationErrorMessage(error instanceof ApiError ? error : undefined));
      // Версия/потребность устарели или остаток строки изменился — подтягиваем актуальные данные заказа
      // для повтора, но только если пользователь не выбрал за это время другой заказ.
      if (selectedOrderId != null && selectedOrderRef.current === selectedOrderId) void loadOrderCard(selectedOrderId);
    } finally {
      setSubmitting(false);
    }
  };

  const unitLabel = onecUnitLabel(line.unitCode, line.unitName);

  return (
    <Modal
      open={open}
      title="Распределить строку на заказ"
      onCancel={onClose}
      onOk={() => void handleSubmit()}
      okText="Распределить"
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {line.nomenclatureName ?? 'Строка без номенклатуры'} · остаток{' '}
          {line.remaining != null ? `${line.remaining} ${isReceipt ? unitLabel : currencySymbol(document.currency)}`.trim() : 'не считается'}
        </Typography.Text>

        <Select<number>
          showSearch
          allowClear
          placeholder="Найдите заказ по номеру или названию"
          style={{ width: '100%' }}
          disabled={submitting}
          loading={ordersLoading}
          filterOption={false}
          value={selectedOrderId}
          onSearch={setOrderSearch}
          onChange={handleOrderChange}
          options={(selectedOrder && !orders.some((order) => order.orderId === selectedOrder.orderId)
            ? [selectedOrder, ...orders]
            : orders
          ).map((order) => ({ value: order.orderId, label: `${order.fullNumber} · ${order.orderName}` }))}
        />

        {orderCard.loading && (
          <Space align="center"><Spin size="small" /><Typography.Text>Загружаю потребности заказа…</Typography.Text></Space>
        )}
        {orderCard.error && <Typography.Text type="danger">{orderCard.error}</Typography.Text>}

        {!isReceipt && selectedOrderId != null && !orderCard.loading && !orderCard.error && (
          <Select<string>
            placeholder="Материал заказа, на который относится оплата"
            style={{ width: '100%' }}
            value={resourceKey}
            onChange={(value) => { setResourceKey(value); setMeasure(null); }}
            options={orderCard.lines.map((candidate) => ({
              value: candidate.resourceKey,
              label: candidate.name,
            }))}
          />
        )}

        {isReceipt && selectedOrderId != null && !orderCard.loading && !orderCard.error && !demandLine && (
          <Typography.Text type="warning">Этого материала нет в потребности заказа.</Typography.Text>
        )}

        <InputNumber<number>
          style={{ width: '100%' }}
          min={0}
          precision={isReceipt ? 3 : 2}
          value={measure}
          onChange={(value) => setMeasure(value)}
          addonAfter={isReceipt ? unitLabel : currencySymbol(document.currency)}
          placeholder={isReceipt ? 'Количество' : 'Сумма'}
        />
      </Space>
    </Modal>
  );
}
