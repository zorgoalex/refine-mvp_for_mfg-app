import React, { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useDataProvider, useInvalidate, useList } from '@refinedev/core';
import { Button, DatePicker, Drawer, Input, InputNumber, message } from 'antd';
import { CheckCircleOutlined, CloseOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  getQuickPaymentAttempt,
  markQuickPaymentReconciled,
  runQuickPaymentAttempt,
  subscribeQuickPaymentAttempts,
} from './quickPaymentAttempts';
import {
  canSubmitQuickPayment,
  quickPaymentMoney,
  quickPaymentReducer,
  quickPaymentStateFromAttempt,
  resolveQuickPaymentType,
  type QuickPaymentPhase,
  quickPaymentNotice,
  quickPaymentPresets,
} from './workbenchQuickPaymentModel';

const LAST_TYPE_KEY = 'erp.quickPayment.typePaidId';

const readLastType = (): number | null => {
  try {
    const value = Number(window.localStorage.getItem(LAST_TYPE_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

const writeLastType = (typePaidId: number) => {
  try {
    window.localStorage.setItem(LAST_TYPE_KEY, String(typePaidId));
  } catch {
    // память способа — удобство, без неё лист работает
  }
};

interface PaymentTypeRow {
  type_paid_id: number;
  type_paid_name: string;
  is_active?: boolean | null;
}

export interface WorkbenchQuickPaymentSheetProps {
  open: boolean;
  orderId: number;
  orderName: string;
  clientName?: string | null;
  remaining: number;
  onClose: () => void;
  /** Перечитать заказ (остаток, оплаты); true — заказ перечитан успешно. */
  onReconcile: () => Promise<boolean>;
  /** Все поля платежа — прежняя форма заказа, вкладка «Финансы». */
  onOpenFullForm: () => void;
}

/**
 * Быстрый платёж NewLine на телефоне (мокап 22): нижний лист поверх карточки заказа.
 * Пишет тем же путём, что «Создание платежа» (`payments` → POST /payments).
 */
export const WorkbenchQuickPaymentSheet: React.FC<WorkbenchQuickPaymentSheetProps> = ({
  open,
  orderId,
  orderName,
  clientName,
  remaining,
  onClose,
  onReconcile,
  onOpenFullForm,
}) => {
  const presets = useMemo(() => quickPaymentPresets(remaining), [remaining]);
  const [typePaidId, setTypePaidId] = useState<number | null>(null);
  const [paymentDate, setPaymentDate] = useState<Dayjs>(() => dayjs());
  const [notes, setNotes] = useState('');
  // Незакрытая попытка этого заказа живёт вне листа (quickPaymentAttempts): новый лист продолжает с неё.
  const attempt = useSyncExternalStore(subscribeQuickPaymentAttempts, () => getQuickPaymentAttempt(orderId));
  const [state, dispatch] = useReducer(quickPaymentReducer, attempt, quickPaymentStateFromAttempt);
  const { phase, amount } = state;
  const phaseRef = useRef<QuickPaymentPhase>(phase);
  phaseRef.current = phase;
  const syncingRef = useRef(false);
  const dataProvider = useDataProvider();
  const invalidate = useInvalidate();

  const { data: typesData, isLoading: typesLoading } = useList<PaymentTypeRow>({
    resource: 'payment_types',
    sorters: [{ field: 'type_paid_id', order: 'asc' }],
    pagination: { pageSize: 100 },
    queryOptions: { enabled: open },
  });
  const types = useMemo(
    () => (typesData?.data ?? []).filter((type) => type.is_active !== false),
    [typesData],
  );
  const activeTypeIds = useMemo(() => types.map((type) => type.type_paid_id), [types]);

  // Запрос завершился (в этом листе или до его монтирования) — переходим к перечитыванию заказа.
  useEffect(() => {
    if (phase === 'submitting' && attempt?.status === 'settled') dispatch({ type: 'settled', outcome: attempt.outcome });
  }, [phase, attempt]);

  // После любой попытки записи: перечитать заказ, оплаты и списки; до успеха новая отправка закрыта.
  useEffect(() => {
    if (phase !== 'syncing' || syncingRef.current) return;
    syncingRef.current = true;
    invalidateLists();
    void onReconcile()
      .catch(() => false)
      .then((ok) => {
        syncingRef.current = false;
        if (ok) markQuickPaymentReconciled(orderId);
        dispatch({ type: 'synced', ok });
      });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Кэши списков: платежи, заказы (`/orders` = orders_view). Вызывается и из попытки, переживающей лист. */
  const invalidateLists = () => {
    void invalidate({ resource: 'payments', invalidates: ['list'] });
    void invalidate({ resource: 'orders_view', invalidates: ['list'] });
    void invalidate({ resource: 'orders', invalidates: ['list'] });
  };

  const recheck = () => {
    if (phaseRef.current === 'stale') dispatch({ type: 'recheck' });
  };

  // Открытие: свободный лист — с чистого листа (сегодня, последний способ, сумма — свежий остаток);
  // непроверенный исход — повторная проверка; остальные состояния сохраняются.
  useEffect(() => {
    if (!open) return;
    if (phaseRef.current === 'stale') {
      recheck();
      return;
    }
    if (phaseRef.current !== 'idle') return;
    dispatch({ type: 'open' });
    setPaymentDate(dayjs());
    setNotes('');
    setTypePaidId(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Предзаполнение — когда лист открыт и свободен, по остатку уже перечитанного заказа.
  useEffect(() => {
    if (open && phase === 'idle' && state.prefillPending) dispatch({ type: 'prefill', amount: presets[0]?.amount ?? null });
  }, [open, phase, state.prefillPending, presets]);

  // Способ всегда из текущего списка активных: пропавший из справочника снимается.
  useEffect(() => {
    if (!open || typesLoading) return;
    const next = resolveQuickPaymentType(typePaidId, readLastType(), activeTypeIds);
    if (next !== typePaidId) setTypePaidId(next);
  }, [open, typesLoading, typePaidId, activeTypeIds]);

  const setAmount = (value: number | null) => dispatch({ type: 'setAmount', amount: value });
  const submitting = phase === 'submitting';
  const blocked = phase === 'submitting' || phase === 'syncing' || phase === 'stale';
  const notice = quickPaymentNotice(remaining, amount);
  const canSubmit = canSubmitQuickPayment({
    phase,
    amount,
    typePaidId,
    activeTypeIds,
    dateValid: paymentDate.isValid(),
  });

  const submit = () => {
    if (!canSubmit || phaseRef.current === 'submitting') return;
    const paid = amount as number;
    const typeId = typePaidId as number;
    // Тот же путь, что «Создание платежа»: dataProvider `payments` → POST /payments.
    const run = runQuickPaymentAttempt(orderId, () => dataProvider().create({
      resource: 'payments',
      variables: {
        order_id: orderId,
        type_paid_id: typeId,
        amount: paid,
        payment_date: paymentDate.format('YYYY-MM-DD'),
        notes: notes.trim() || null,
      },
    }), invalidateLists);
    if (!run) return; // по заказу ещё идёт или не перечитана прошлая попытка
    phaseRef.current = 'submitting';
    dispatch({ type: 'submit' });
    void run.then(({ outcome, error }) => {
      if (outcome === 'success') {
        writeLastType(typeId);
        message.success(`Платёж ${quickPaymentMoney(paid)} добавлен к заказу ${orderName}`);
        onClose();
      } else if (outcome === 'rejected') {
        const text = (error as { message?: unknown } | undefined)?.message;
        message.error(typeof text === 'string' && text ? text : 'Платёж не записан');
      } else {
        message.warning('Ответ сервера не получен — проверяем, записался ли платёж');
      }
    });
  };

  const subtitle = [`Заказ ${orderName}`, clientName, remaining > 0 ? `остаток ${quickPaymentMoney(remaining)}` : 'оплачен']
    .filter(Boolean)
    .join(' · ');

  return (
    <Drawer
      rootClassName="wb-paysheet"
      open={open}
      onClose={submitting ? undefined : onClose}
      maskClosable={!submitting}
      placement="bottom"
      height="auto"
      closable={false}
      title={null}
      destroyOnClose
    >
      <div className="wb-paysheet__body" role="group" aria-labelledby="wb-paysheet-title">
        <span className="wb-paysheet__grab" aria-hidden="true" />
        <div className="wb-paysheet__head">
          <div>
            <h2 id="wb-paysheet-title">Добавить платёж</h2>
            <div className="wb-paysheet__sub">{subtitle}</div>
          </div>
          <Button type="text" aria-label="Закрыть" icon={<CloseOutlined />} onClick={onClose} disabled={submitting} />
        </div>

        <div className="wb-paysheet__field">
          <label className="wb-paysheet__label" htmlFor="wb-paysheet-amount">Сумма</label>
          <InputNumber<number>
            id="wb-paysheet-amount"
            className="wb-paysheet__amount"
            inputMode="decimal"
            min={0.01}
            step={1}
            precision={2}
            value={amount}
            disabled={blocked}
            onChange={(value) => setAmount(typeof value === 'number' ? value : null)}
            formatter={(value, info) => {
              if (info.userTyping) return info.input;
              const [int, frac] = String(value ?? '').split('.');
              const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
              return frac && Number(frac) !== 0 ? `${grouped},${frac}` : grouped;
            }}
            parser={(value) => Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'))}
            addonAfter="₸"
          />
          {presets.length > 0 ? (
            <div className="wb-paysheet__chips">
              {presets.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="wb-paysheet__chip"
                  aria-pressed={amount === preset.amount}
                  disabled={blocked}
                  onClick={() => setAmount(preset.amount)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="wb-paysheet__field">
          <span className="wb-paysheet__label" id="wb-paysheet-way">Способ оплаты</span>
          <div className="wb-paysheet__seg" role="group" aria-labelledby="wb-paysheet-way" aria-busy={typesLoading}>
            {types.map((type) => (
              <button
                key={type.type_paid_id}
                type="button"
                aria-pressed={typePaidId === type.type_paid_id}
                onClick={() => setTypePaidId(type.type_paid_id)}
              >
                {type.type_paid_name}
              </button>
            ))}
          </div>
        </div>

        <div className="wb-paysheet__row">
          <div className="wb-paysheet__field">
            <label className="wb-paysheet__label" htmlFor="wb-paysheet-date">Дата</label>
            <DatePicker
              id="wb-paysheet-date"
              value={paymentDate}
              onChange={(value) => setPaymentDate(value ?? dayjs())}
              format="DD.MM.YYYY"
              allowClear={false}
              inputReadOnly
            />
          </div>
          <div className="wb-paysheet__field">
            <label className="wb-paysheet__label" htmlFor="wb-paysheet-notes">Примечание</label>
            <Input id="wb-paysheet-notes" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>

        {phase === 'syncing' ? (
          <div className="wb-paysheet__notice" data-tone="info" role="status">
            <InfoCircleOutlined />
            <div>Обновляем заказ после прошлой отправки…</div>
          </div>
        ) : phase === 'stale' ? (
          <div className="wb-paysheet__notice" data-tone="warn" role="alert">
            <ExclamationCircleOutlined />
            <div>
              Не удалось перечитать заказ после прошлой отправки: платёж мог записаться. Новый платёж — после проверки.{' '}
              <button type="button" className="wb-link" onClick={recheck}>Проверить ещё раз</button>
            </div>
          </div>
        ) : phase === 'review' ? (
          <div className="wb-paysheet__notice" data-tone="warn" role="alert">
            <ExclamationCircleOutlined />
            <div>
              Ответ сервера не получен, платёж мог записаться. Остаток обновлён — проверьте оплаты заказа
              и введите сумму заново, если платежа там нет.
            </div>
          </div>
        ) : null}
        {notice && !blocked ? (
          <div className="wb-paysheet__notice" data-tone={notice.tone} role="status">
            {notice.tone === 'ok' ? <CheckCircleOutlined /> : notice.tone === 'warn' ? <ExclamationCircleOutlined /> : <InfoCircleOutlined />}
            <div>{notice.text}</div>
          </div>
        ) : null}

        <button type="button" className="wb-link wb-paysheet__full" onClick={onOpenFullForm} disabled={submitting}>
          Открыть полную форму платежей
        </button>
        <div className="wb-paysheet__acts">
          <Button onClick={onClose} disabled={submitting}>Отмена</Button>
          <Button type="primary" onClick={submit} loading={submitting || phase === 'syncing'} disabled={!canSubmit}>Добавить платёж</Button>
        </div>
      </div>
    </Drawer>
  );
};
