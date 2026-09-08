(() => {
  'use strict';

  const token = document.body.dataset.widgetToken;
  const notice = document.getElementById('notice');
  const form = document.getElementById('payment-form');
  const summary = document.getElementById('summary');
  const amount = document.getElementById('amount');
  const paymentDate = document.getElementById('paymentDate');
  const paySystem = document.getElementById('paySystemId');
  const comment = document.getElementById('comment');
  const confirmBox = document.getElementById('confirmOverpayment');
  const confirmRow = document.getElementById('overpayment-row');
  const submit = document.getElementById('submit');
  const recent = document.getElementById('recent-list');
  let context = null;
  let idempotencyKey = crypto.randomUUID();
  let pendingOverpaymentCommandId = null;

  const inProgressStatuses = new Set([
    'processing',
    'pre_create_saved',
    'remote_create_started',
    'remote_created',
    'snapshot_saved',
    'awaiting_erp_retry',
  ]);

  const api = async (path, options = {}) => {
    const response = await fetch(`../widget-api/${path}`, {
      ...options,
      headers: {
        Authorization: `BitrixWidget ${token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({
      error: { code: 'INVALID_RESPONSE', message: 'Некорректный ответ сервера' },
    }));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'Ошибка запроса');
      error.code = payload.error?.code;
      error.details = payload.error?.details;
      throw error;
    }
    return payload;
  };

  const money = (value) => value === null
    ? '—'
    : `${new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value))} ₸`;

  const setNotice = (text, kind = '') => {
    notice.textContent = text;
    notice.className = `notice ${kind}`.trim();
  };

  // Canonicalize decimal text without float parsing or silent rounding.
  const canonicalAmount = (value) => {
    const match = /^(0|[1-9][0-9]{0,11})(?:[.,]([0-9]{1,2}))?$/.exec(value.trim());
    if (!match) throw new Error('Сумма: введите положительное число, не более двух знаков после точки или запятой. Например: 5000 или 5000,50.');
    const result = `${match[1]}.${(match[2] || '').padEnd(2, '0')}`;
    if (result === '0.00') throw new Error('Сумма должна быть больше нуля.');
    return result;
  };

  const validationMessage = (error) => {
    const messages = {
      amount: 'Сумма: проверьте положительное значение и не более двух дробных знаков.',
      paymentDate: 'Дата оплаты: укажите существующую календарную дату.',
      paySystemId: 'Платёжная система: выберите значение из списка.',
      comment: 'Комментарий: не более 1000 символов.',
      expectedOrderVersion: 'Версия заказа: нажмите «Обновить» перед отправкой.',
      confirmOverpayment: 'Подтверждение переплаты: проверьте состояние флажка.',
    };
    const errors = Array.isArray(error.details?.errors) ? error.details.errors : [];
    const known = errors.map((item) => Object.prototype.hasOwnProperty.call(messages, item?.field) ? messages[item.field] : null).filter(Boolean);
    return [...new Set(known)].join(' ') || 'Проверьте заполнение полей оплаты и обновите форму.';
  };

  const waitForCommand = async (initial) => {
    let command = initial;
    for (let attempt = 0; attempt < 15 && inProgressStatuses.has(command.status); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      command = await api(`commands/${encodeURIComponent(command.commandId)}`);
    }
    return command;
  };

  const drawRecent = (rows) => {
    recent.replaceChildren();
    if (!rows.length) {
      recent.className = 'empty';
      recent.textContent = 'Нет оплат из Bitrix';
      return;
    }
    recent.className = 'recent-list';
    for (const row of rows) {
      const element = document.createElement('div');
      element.className = 'payment';
      const title = document.createElement('strong');
      title.textContent = money(row.amount);
      const state = document.createElement('small');
      state.textContent = row.erpPaymentId ? `ERP #${row.erpPaymentId}` : row.state;
      const meta = document.createElement('small');
      meta.textContent = `Bitrix #${row.bitrixPaymentId} · ${row.paymentDate || 'дата не указана'} · ${row.paySystemName || 'система не указана'}`;
      element.append(title, state, meta);
      recent.append(element);
    }
  };

  const load = async () => {
    setNotice('Загрузка…');
    form.hidden = true;
    try {
      context = await api('context');
      summary.hidden = false;
      summary.replaceChildren();
      for (const [label, value] of [
        ['Заказ ERP', context.erp.orderId ? `#${context.erp.orderId}` : 'Ещё не создан'],
        ['Сумма', money(context.erp.finalAmount)],
        ['Долг', money(context.erp.debtAmount)],
      ]) {
        const cell = document.createElement('div');
        const caption = document.createElement('span');
        caption.textContent = label;
        const content = document.createElement('strong');
        content.textContent = value;
        cell.append(caption, content);
        summary.append(cell);
      }
      paySystem.replaceChildren(...context.paymentSystems.map((system) => {
        const option = document.createElement('option');
        option.value = String(system.id);
        option.textContent = system.name;
        if (system.isDefault) option.selected = true;
        return option;
      }));
      paymentDate.value = context.serverDate;
      drawRecent(context.recentPayments);
      if (context.canCreate) {
        form.hidden = false;
        setNotice('Готово к добавлению оплаты', 'success');
      } else {
        setNotice(`Добавление заблокировано: ${context.blockReason}`, 'warning');
      }
    } catch (error) {
      setNotice(
        error.code === 'BITRIX24_WIDGET_SESSION_EXPIRED'
          ? 'Сессия истекла. Перезагрузите вкладку сделки.'
          : error.message,
        'error',
      );
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setNotice('Создаю оплату…');
    try {
      const body = {
        amount: canonicalAmount(amount.value),
        paymentDate: paymentDate.value,
        paySystemId: Number(paySystem.value),
        comment: comment.value.trim() || null,
        expectedOrderVersion: context.erp.orderVersion,
        confirmOverpayment: confirmBox.checked,
      };
      if (pendingOverpaymentCommandId && !confirmBox.checked) {
        setNotice('Подтвердите перенос переплаты в ERP.', 'warning');
        return;
      }
      const initial = pendingOverpaymentCommandId
        ? await api(`commands/${encodeURIComponent(pendingOverpaymentCommandId)}/confirm-overpayment`, {
            method: 'POST',
          })
        : await api('payments', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          });
      const result = await waitForCommand(initial);
      if (result.status === 'awaiting_overpayment_confirmation') {
        pendingOverpaymentCommandId = result.commandId;
        confirmRow.hidden = false;
        confirmBox.checked = false;
      } else {
        pendingOverpaymentCommandId = null;
        idempotencyKey = crypto.randomUUID();
        amount.value = '';
        comment.value = '';
        confirmRow.hidden = true;
      }
      await load();
      setNotice(result.message, result.status === 'completed' ? 'success' : 'warning');
    } catch (error) {
      if (error.code === 'VALIDATION_ERROR') {
        setNotice(validationMessage(error), 'error');
      } else if (error.code === 'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED') {
        confirmRow.hidden = false;
        setNotice(
          'Сумма создаёт переплату. Отметьте подтверждение и отправьте снова.',
          'warning',
        );
      } else if (error.code === 'BITRIX24_PAYMENT_CREATE_AMBIGUOUS') {
        const command = error.details?.commandId ? ` Команда: ${error.details.commandId}.` : '';
        setNotice(
          `${error.message}.${command} Не отправляйте новую оплату; сообщите администратору.`,
          'error',
        );
      } else {
        setNotice(error.message, 'error');
      }
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('refresh').addEventListener('click', load);
  void load();
})();
