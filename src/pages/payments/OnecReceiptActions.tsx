import { Alert, Button, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import React, { useRef, useState } from 'react';

import { isApiError } from '../../api/apiError';
import { ordersApi } from '../../api/ordersApi';
import { paymentsOnecApi } from '../../api/paymentsOnecApi';
import type { OnecReceiptCardResponse, OnecReceiptCommandResponse } from '../../api/types/paymentsOnecApi.types';
import { formatDate } from '../../utils/dateFormat';
import { formatOnecMoney, onecReceiptActions, onecReceiptCommandErrorText } from './onecReceipts';

const { Text } = Typography;
const NOTE_MAX = 500;
const NOTE_HINT = 'Не указывайте телефоны и личные данные.';

type Candidate = OnecReceiptCardResponse['candidates'][number];

/** Что открыто: одна модалка за раз. */
type Dialog =
  | { kind: 'match'; candidate: Candidate }
  | { kind: 'dismiss' }
  | { kind: 'unmatch' }
  | { kind: 'link' }
  | { kind: 'unlink' }
  | null;

function errorText(error: unknown): string {
  return onecReceiptCommandErrorText(isApiError(error) ? error.code : null);
}

/**
 * Ручные команды карточки «Поступления 1С» (срез B): сопоставить с платежом, «разобрано», снять, связь заказа 1С.
 * Кнопки — только при `capabilities.commands`; решение и проверки — на backend (токены, права, область видимости).
 * После любой команды (и при 409 «данные изменились») карточка и список перечитываются.
 */
export function useOnecReceiptCommands(card: OnecReceiptCardResponse, onChanged: () => void) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<'order' | 'not_erp'>('order');
  const [orderId, setOrderId] = useState<number | null>(null);
  const [orderOptions, setOrderOptions] = useState<Array<{ value: number; label: string }>>([]);
  const searchGeneration = useRef(0);
  const line = card.line;
  const actions = onecReceiptActions(line, card.capabilities.commands);

  const open = (next: Dialog) => {
    setDialog(next);
    setNote('');
    setError(null);
    setLinkMode('order');
    setOrderId(null);
  };
  const close = () => {
    if (!busy) setDialog(null);
  };

  const run = async (action: () => Promise<OnecReceiptCommandResponse>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setDialog(null);
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
      // Устаревшие данные: перечитать, чтобы следующая попытка шла с новым токеном.
      if (isApiError(failure, 'ONEC_RECEIPT_STATE_CHANGED')) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const searchOrders = async (text: string) => {
    const generation = ++searchGeneration.current;
    try {
      const result = await ordersApi.list({ search: text || undefined, page: 1, pageSize: 20 });
      if (generation !== searchGeneration.current) return;
      setOrderOptions(result.data.map((order) => ({
        value: order.orderId,
        label: `${order.orderName}${order.clientName ? ` — ${order.clientName}` : ''}`,
      })));
    } catch {
      if (generation === searchGeneration.current) setOrderOptions([]);
    }
  };

  const noteInput = (required: boolean, placeholder: string) => (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      <Input.TextArea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={NOTE_MAX}
        showCount
        autoSize={{ minRows: 2, maxRows: 5 }}
        placeholder={placeholder}
        status={required && note.trim().length === 0 ? 'warning' : undefined}
      />
      <Text type="secondary">{NOTE_HINT}</Text>
    </Space>
  );

  const toolbar = card.capabilities.commands ? (
    <Space wrap>
      {actions.dismiss && <Button onClick={() => open({ kind: 'dismiss' })}>Разобрано…</Button>}
      {actions.unmatch && (
        <Button danger onClick={() => open({ kind: 'unmatch' })}>
          {line.match?.kind === 'dismissed' ? 'Снять отметку «разобрано»' : 'Снять сверку'}
        </Button>
      )}
      {actions.link && <Button onClick={() => open({ kind: 'link' })}>Заказ…</Button>}
      {actions.unlink && <Button onClick={() => open({ kind: 'unlink' })}>Вернуть заказ по номеру</Button>}
    </Space>
  ) : null;

  /** Кнопка в строке платежа-кандидата (только свободные платежи и строка, ожидающая сопоставления). */
  const matchButton = (candidate: Candidate) =>
    actions.match && candidate.matchedTo === null ? (
      <Button size="small" type="link" onClick={() => open({ kind: 'match', candidate })}>Сопоставить</Button>
    ) : null;

  const matchNeedsNote = dialog?.kind === 'match' && !dialog.candidate.sameAmount;
  const okDisabled =
    (dialog?.kind === 'dismiss' && note.trim().length === 0)
    || (matchNeedsNote && note.trim().length === 0)
    || (dialog?.kind === 'link' && linkMode === 'order' && orderId === null);

  const onOk = () => {
    if (!dialog) return;
    const trimmed = note.trim() || null;
    if (dialog.kind === 'match') {
      void run(() => paymentsOnecApi.match(line.lineId, {
        paymentId: dialog.candidate.paymentId,
        expectedStateToken: line.stateToken,
        expectedPaymentToken: dialog.candidate.paymentToken,
        note: trimmed,
      }));
    } else if (dialog.kind === 'dismiss') {
      void run(() => paymentsOnecApi.dismiss(line.lineId, { expectedStateToken: line.stateToken, note: note.trim() }));
    } else if (dialog.kind === 'unmatch' && line.match) {
      const matchId = line.match.matchId;
      void run(() => paymentsOnecApi.unmatch(line.lineId, { expectedMatchId: matchId, reason: trimmed }));
    } else if (dialog.kind === 'link') {
      void run(() => paymentsOnecApi.linkOrder(line.lineId, {
        expectedStateToken: line.stateToken, orderId: linkMode === 'order' ? orderId : null, note: trimmed,
      }));
    } else if (dialog.kind === 'unlink') {
      void run(() => paymentsOnecApi.unlinkOrder(line.lineId, { expectedStateToken: line.stateToken }));
    }
  };

  const titles: Record<NonNullable<Dialog>['kind'], string> = {
    match: 'Сопоставить с платежом',
    dismiss: 'Разобрано без сверки',
    unmatch: line.match?.kind === 'dismissed' ? 'Снять отметку «разобрано»' : 'Снять сверку',
    link: 'Заказ приложения для заказа 1С',
    unlink: 'Вернуть заказ по номеру',
  };

  const modal = (
    <Modal
      open={dialog !== null}
      title={dialog ? titles[dialog.kind] : ''}
      onCancel={close}
      onOk={onOk}
      okText="Подтвердить"
      cancelText="Отмена"
      confirmLoading={busy}
      okButtonProps={{ disabled: okDisabled, danger: dialog?.kind === 'unmatch' }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {dialog?.kind === 'match' && (
          <>
            <Text>
              Поступление 1С {formatOnecMoney(line.amount)} от {formatDate(line.date)} ↔ платёж {formatOnecMoney(dialog.candidate.amount)} от{' '}
              {formatDate(dialog.candidate.paymentDate)}{dialog.candidate.typeName ? `, ${dialog.candidate.typeName}` : ''}
            </Text>
            {!dialog.candidate.sameAmount && <Alert type="warning" showIcon message="Суммы различаются — комментарий обязателен" />}
            {noteInput(matchNeedsNote, matchNeedsNote ? 'Почему суммы различаются' : 'Комментарий (необязательно)')}
          </>
        )}
        {dialog?.kind === 'dismiss' && (
          <>
            <Text>Поступление будет отмечено как разобранное без связи с платежом. Отметку можно снять.</Text>
            {noteInput(true, 'Почему поступление не сверяется с платежом')}
          </>
        )}
        {dialog?.kind === 'unmatch' && (
          <>
            <Text>Запись останется в истории сверки. Платежи и заказы не меняются.</Text>
            {noteInput(false, 'Причина (необязательно)')}
          </>
        )}
        {dialog?.kind === 'link' && (
          <>
            <Text>Заказ 1С: {line.onecOrder?.number ?? 'не загружен'}</Text>
            <Radio.Group value={linkMode} onChange={(event) => setLinkMode(event.target.value)}>
              <Space direction="vertical">
                <Radio value="order">Это заказ приложения</Radio>
                <Radio value="not_erp">Заказ 1С не относится к приложению</Radio>
              </Space>
            </Radio.Group>
            {linkMode === 'order' && (
              <Select<number>
                showSearch
                style={{ width: '100%' }}
                placeholder="Номер заказа или клиент"
                filterOption={false}
                value={orderId ?? undefined}
                onSearch={(text) => void searchOrders(text)}
                onFocus={() => void searchOrders('')}
                onChange={(value) => setOrderId(value)}
                options={orderOptions}
                notFoundContent="Заказы не найдены"
              />
            )}
            {noteInput(false, 'Комментарий (необязательно)')}
          </>
        )}
        {dialog?.kind === 'unlink' && <Text>Ручная связь будет снята, заказ определится снова по номеру заказа 1С.</Text>}
        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  );

  return { toolbar, matchButton, modal };
}
