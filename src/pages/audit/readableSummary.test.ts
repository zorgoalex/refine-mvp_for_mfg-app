import { describe, expect, it } from 'vitest';
import type { AuditLogEventDto } from '../../api/types/auditApi.types';
import { auditActor, buildAuditReadableSummary } from './readableSummary';

function event(overrides: Partial<AuditLogEventDto> = {}): AuditLogEventDto {
  return {
    auditId: 'a1',
    event: 'orders.update',
    entityType: 'order',
    entityId: '42',
    entityName: '2728',
    entityDetailNumber: null,
    userId: 7,
    username: 'manager',
    role: 'top_manager',
    source: 'backend-production-actions',
    relatedOrderId: 42,
    relatedOrderName: '2728',
    relatedClientId: 12,
    relatedClientName: 'Тест клиент',
    relatedPaymentId: null,
    relatedDeadlineId: null,
    relatedProductionEventId: null,
    relatedUserId: null,
    relatedEntities: [],
    statusField: null,
    statusId: null,
    statusName: null,
    statusCode: null,
    stageCode: null,
    requestId: 'req-1',
    ip: '10.0.0.1',
    userAgent: 'Mozilla/5.0',
    before: null,
    after: null,
    diff: null,
    metadata: null,
    createdAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildAuditReadableSummary', () => {
  it.each(['cut_job.deleted', 'cut_job.created', 'cut_job.result_archived'])('keeps the cutting job primary for %s', (name) => {
    const summary = buildAuditReadableSummary(event({
      event: name, entityType: 'cut_job', entityId: '912', entityName: null,
      metadata: { cutJobId: 912, cutJobDisplayNumber: 'В-27', cutJobName: 'Тест раскрой' },
      relatedEntities: [{ entityType: 'sheet_material_type', entityId: 3 }],
    }));
    expect(summary.object).toBe('Задание на раскрой №В-27 (ID: 912) — Тест раскрой');
    expect(summary.related).toContain('Заказ 2728 (#42)');
    expect(summary.related).toContain('Тип листового материала #3');
    if (name === 'cut_job.deleted') expect(summary.title).toBe('Удалено задание на раскрой');
  });

  it('never invents a cutting display number from its internal ID', () => {
    const summary = buildAuditReadableSummary(event({ event: 'cut_job.deleted', entityType: 'cut_job', entityId: '912', entityName: null }));
    expect(summary.object).toBe('Задание на раскрой (ID: 912; номер не сохранён)');
  });

  it('shows the applied automation rule and exact detail status transition', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'status_automation.rule_applied',
        entityType: 'status_automation_rule',
        entityId: '4',
        entityName: null,
        relatedOrderId: 11520,
        relatedOrderName: '2777',
        source: 'backend-status-automation',
        metadata: {
          ruleName: 'Готов к выдаче -> произ-во Упакован',
          eventType: 'order.status_changed',
          actionType: 'change_details_production_status',
          targetStatusId: 7,
          statusCommandAuditId: '29987552-3914-4bb9-985b-c9690d366fd1',
          statusCommand: {
            auditId: '29987552-3914-4bb9-985b-c9690d366fd1',
            event: 'orders.detail_production_status_batch_change',
            statusField: 'productionDetailBatch',
            statusId: 7,
            statusName: 'Упакован',
            statusCode: 'packed',
            before: { detailStatusDistribution: { 2: 8 } },
            after: { detailStatusDistribution: { 7: 8 } },
            diff: {
              affectedDetailCount: 8,
              beforeStatusDistribution: { 2: 8 },
              afterStatusDistribution: { 7: 8 },
            },
            statusCatalog: {
              2: { name: 'Распилен', code: 'cut' },
              7: { name: 'Упакован', code: 'packed' },
            },
          },
        },
      }),
    );

    expect(summary.title).toBe('Применено правило автостатусов');
    expect(summary.object).toBe('Заказ 2777 (#11520)');
    expect(summary.changes).toEqual([
      {
        label: 'Производственный статус деталей',
        before: 'Распилен (cut) × 8',
        after: 'Упакован (packed) × 8',
      },
    ]);
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        'Правило: Готов к выдаче -> произ-во Упакован (#4)',
        'Сработало после: изменения статуса заказа',
        'Изменено деталей: 8',
        'Источник: автоматизация',
      ]),
    );
  });

  it('shows an exact order status transition for an applied automation rule', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'status_automation.rule_applied',
        entityType: 'status_automation_rule',
        entityId: '6',
        metadata: {
          ruleName: 'пр Распилен -> В производстве',
          eventType: 'order.production_status_changed',
          actionType: 'change_order_status',
          targetStatusId: 4,
          statusCommand: {
            event: 'orders.status_change',
            statusField: 'orderStatus',
            statusId: 4,
            statusName: 'В производстве',
            before: { orderStatusId: 2 },
            after: { orderStatusId: 4, orderStatusName: 'В производстве' },
            diff: { orderStatusId: { before: 2, after: 4 } },
            statusCatalog: {
              2: { name: 'Новый', code: null },
              4: { name: 'В производстве', code: null },
            },
          },
        },
      }),
    );

    expect(summary.changes).toEqual([
      {
        label: 'Статус заказа',
        before: 'Новый',
        after: 'В производстве',
      },
    ]);
  });

  it('describes order status changes without using target metadata as the previous value', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.status_change',
        statusField: 'orderStatus',
        statusId: 2,
        statusName: 'Готов к выдаче',
        before: { orderStatusId: 1, version: 5 },
        after: {
          orderStatusId: 2,
          orderStatusName: 'Готов к выдаче',
          version: 6,
        },
        diff: { orderStatusId: { before: 1, after: 2 } },
        metadata: {
          orderId: 42,
          orderStatusId: 2,
          orderStatusName: 'Готов к выдаче',
          previousOrderStatusId: 1,
          requestId: 'req-1',
        },
      })
    );

    expect(summary.title).toBe('Изменён статус заказа');
    expect(summary.actor).toBe('manager (top_manager)');
    expect(summary.object).toBe('Заказ 2728 (#42)');
    expect(summary.changes).toContainEqual({
      label: 'Статус заказа',
      before: '#1',
      after: 'Готов к выдаче',
    });
  });

  it('describes batch detail production status changes with selected and changed counts', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.detail_production_status_batch_change',
        statusField: 'productionDetailBatch',
        statusId: 4,
        statusName: 'Раскрой',
        statusCode: 'CUT',
        diff: {
          detailIds: [101, 102, 103],
          changedDetailIds: [101, 103],
          selectedDetailCount: 3,
          affectedDetailCount: 2,
          productionStatusId: 4,
          orderVersion: { before: 10, after: 11 },
        },
        metadata: {
          orderId: 42,
          productionStatusId: 4,
          productionStatusName: 'Раскрой',
          productionStatusCode: 'CUT',
        },
        relatedEntities: [
          { entityType: 'order_detail', entityId: 101, detailNumber: 1 },
          { entityType: 'order_detail', entityId: 102, detailNumber: 2 },
          { entityType: 'order_detail', entityId: 103, detailNumber: 3 },
        ],
      })
    );

    expect(summary.title).toBe('Изменён производственный статус деталей заказа');
    expect(summary.changes).toContainEqual({
      label: 'Статус выбранных деталей',
      before: 'разные статусы',
      after: 'Раскрой (CUT)',
    });
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        'Выбрано деталей: 3',
        'Изменено деталей: 2',
        'Детали: Деталь №1 (#101), Деталь №2 (#102), Деталь №3 (#103)',
      ])
    );
  });

  it('uses system actor metadata when no user account is attached', () => {
    const summary = buildAuditReadableSummary(
      event({
        userId: null,
        username: null,
        role: null,
        source: 'deadline-engine',
        event: 'orders.status_change',
        metadata: {
          orderId: 42,
          systemActor: { actorLabel: 'Deadline rule #9' },
        },
        diff: { orderStatusId: { before: 2, after: 3 } },
        after: { orderStatusName: 'Просрочен' },
      })
    );

    expect(summary.actor).toBe('Deadline rule #9');
    expect(summary.notes).toContain('Источник: системное правило');
  });

  it('keeps readable field changes and hides technical fields', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.update',
        diff: {
          plannedCompletionDate: {
            before: '2026-08-01T09:00:00.000Z',
            after: '2026-08-05T09:00:00.000Z',
          },
          version: { before: 1, after: 2 },
          requestId: { before: 'old', after: 'new' },
        },
      })
    );

    expect(summary.title).toBe('Обновлён заказ');
    expect(summary.changes.map((change) => change.label)).toContain('Плановая дата завершения');
    expect(summary.changes.map((change) => change.label)).not.toContain('Version');
    expect(summary.changes.map((change) => change.label)).not.toContain('Request id');
  });

  it('describes order detail transfers with detail list and source/target orders', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.detail_transfer',
        entityType: 'order',
        entityId: '11471',
        relatedOrderId: 11472,
        username: 'ivan',
        role: 'manager',
        metadata: {
          sourceOrderId: 11471,
          sourceOrderName: '2728',
          targetOrderId: 11472,
          targetOrderName: '2729',
          movedDetails: [
            {
              detailId: 1001,
              sourceDetailNumber: 3,
              targetDetailNumber: 7,
              height: 716,
              width: 396,
              quantity: 2,
            },
          ],
        },
      })
    );

    expect(summary.title).toBe('Перенесены детали заказа');
    expect(summary.actor).toBe('ivan (manager)');
    expect(summary.object).toBe('Заказ 2728 (#11471) → Заказ 2729 (#11472)');
    expect(summary.changes).toContainEqual({
      label: 'Детали',
      before: 'Заказ 2728 (#11471)',
      after: 'Заказ 2729 (#11472)',
    });
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        'Какие детали: Деталь №3→№7 (#1001) (716x396 x2)',
        'Из заказа: Заказ 2728 (#11471)',
        'В заказ: Заказ 2729 (#11472)',
      ])
    );
  });
});

describe('payment audit events', () => {
  const pay = (overrides: Partial<AuditLogEventDto>) =>
    event({ entityType: 'payment', entityId: '900', relatedPaymentId: 900, ...overrides });
  const find = (summary: ReturnType<typeof buildAuditReadableSummary>, label: string) =>
    summary.changes.find((change) => change.label === label);

  it('shows a created payment with totals and hides technical keys', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.create',
      before: { orderPaidAmount: 0, orderPaymentStatusName: null },
      after: { paymentId: 900, amount: 142716, paymentDate: '2026-10-17', typePaidName: 'Наличные', typePaidId: 3, createdBy: 7, deleted: false, orderPaidAmount: 142716, orderPaymentStatusName: 'Оплачен' },
      diff: {
        paymentId: { from: null, to: 900 },
        amount: { from: null, to: 142716 },
        paymentDate: { from: null, to: '2026-10-17' },
        typePaidId: { from: null, to: 3 },
        typePaidName: { from: null, to: 'Наличные' },
        createdBy: { from: null, to: 7 },
        deleted: { from: null, to: false },
        orderPaidAmount: { from: 0, to: 142716 },
        orderPaymentStatusName: { from: null, to: 'Оплачен' },
      },
      metadata: { origin: 'order_form', previousOrderId: null },
    }));
    expect(summary.title).toBe('Добавлен платёж');
    expect(summary.actor).toBe('manager (top_manager)');
    expect(summary.changes).toEqual([
      { label: 'Сумма', before: '—', after: '142 716' },
      { label: 'Дата оплаты', before: '—', after: '17.10.2026' },
      { label: 'Тип оплаты', before: '—', after: 'Наличные' },
      { label: 'Оплачено по заказу', before: '0', after: '142 716' },
      { label: 'Статус оплаты', before: '—', after: 'Оплачен' },
    ]);
    expect(summary.notes).toContain('Источник: форма заказа');
  });

  it('shows an update from diff, accepting before/after pairs too', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.update',
      diff: { amount: { before: 1000, after: 1500.5 }, notes: { before: null, after: 'аванс' }, refKey1c: { from: 'A', to: 'B' }, editedBy: { from: 1, to: 2 }, updatedAt: { from: 'x', to: 'y' } },
      metadata: { origin: 'payment_command' },
    }));
    expect(summary.changes).toEqual([
      { label: 'Сумма', before: '1 000', after: '1 500,50' },
      { label: 'Примечание', before: '—', after: 'аванс' },
      { label: 'Ссылка 1С', before: 'A', after: 'B' },
    ]);
    expect(summary.notes).toContain('Источник: раздел «Платежи»');
  });

  it('shows a deleted payment', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.delete',
      before: { amount: 142717, orderPaidAmount: 142717, orderPaymentStatusName: 'Оплачен' },
      after: { deleted: true, orderPaidAmount: 0, orderPaymentStatusName: null },
      diff: { deleted: { from: false, to: true }, orderPaidAmount: { from: 142717, to: 0 }, orderPaymentStatusName: { from: 'Оплачен', to: null } },
    }));
    expect(summary.title).toBe('Удалён платёж');
    expect(find(summary, 'Сумма')).toEqual({ label: 'Сумма', before: '142 717', after: 'удалена' });
    expect(find(summary, 'Оплачено по заказу')).toEqual({ label: 'Оплачено по заказу', before: '142 717', after: '0' });
    expect(find(summary, 'Статус оплаты')).toEqual({ label: 'Статус оплаты', before: 'Оплачен', after: '—' });
    expect(summary.changes.find((c) => c.label === 'Deleted')).toBeUndefined();
  });

  it('shows a restored payment', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.restore',
      before: { orderPaidAmount: 0 },
      after: { amount: 5000, orderPaidAmount: 5000 },
      diff: { orderPaidAmount: { from: 0, to: 5000 } },
    }));
    expect(summary.title).toBe('Восстановлен платёж');
    expect(summary.notes).toContain('Платёж восстановлен');
    expect(find(summary, 'Сумма')).toEqual({ label: 'Сумма', before: 'удалена', after: '5 000' });
  });

  it('shows a move between orders using previousOrderId and the diff', () => {
    const viaMetadata = buildAuditReadableSummary(pay({
      event: 'payments.update',
      before: { orderId: 11 }, after: { orderId: 12 },
      diff: { amount: { from: 10, to: 20 } },
      metadata: { previousOrderId: 11 },
    }));
    expect(find(viaMetadata, 'Заказ')).toEqual({ label: 'Заказ', before: '#11', after: '#12' });
    const viaDiff = buildAuditReadableSummary(pay({ event: 'payments.update', diff: { orderId: { from: 11, to: 12 } } }));
    expect(find(viaDiff, 'Заказ')).toEqual({ label: 'Заказ', before: '#11', after: '#12' });
  });

  it('falls back to before/after for old records without diff', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.update',
      before: { paymentId: 900, orderId: 11, amount: 1000, typePaidId: 1, typePaidName: 'Наличные', notes: null, createdAt: 'a', updatedAt: 'b' },
      after: { paymentId: 900, orderId: 11, amount: 2000, typePaidId: 2, typePaidName: 'Карта', notes: null, createdAt: 'a', updatedAt: 'c' },
    }));
    expect(summary.changes).toEqual([
      { label: 'Сумма', before: '1 000', after: '2 000' },
      { label: 'Тип оплаты', before: 'Наличные', after: 'Карта' },
    ]);
  });

  it('falls back to the type id when no type name exists', () => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.update', before: { typePaidId: 1 }, after: { typePaidId: 2 },
    }));
    expect(summary.changes).toEqual([{ label: 'Тип оплаты', before: '1', after: '2' }]);
  });

  it.each([
    ['order_form', 'Источник: форма заказа'],
    ['payment_command', 'Источник: раздел «Платежи»'],
    ['snapshot_import', 'Источник: импорт'],
    ['bitrix24_reverse_manual', 'Источник: Bitrix24 (вручную)'],
    ['bitrix24_reverse_auto', 'Источник: Bitrix24 (автоматически)'],
    ['bitrix24_widget', 'Источник: виджет Bitrix24'],
  ])('shows the source line for origin %s', (origin, line) => {
    const summary = buildAuditReadableSummary(pay({
      event: 'payments.update', diff: { amount: { from: 1, to: 2 } }, metadata: { origin },
    }));
    expect(summary.notes).toContain(line);
  });
});

describe('bitrix payment effect events', () => {
  const effect = (name: string, overrides: Partial<AuditLogEventDto> = {}) =>
    event({ event: name, entityType: 'payment', entityId: '900', userId: null, username: null, role: null, source: 'crm-sync', ...overrides });

  it('shows the automatic actor instead of an empty author', () => {
    const summary = buildAuditReadableSummary(effect('crm_sync.payment_card_closed'));
    expect(summary.actor).toBe('Синхронизация с Bitrix (автоматически)');
    expect(auditActor(effect('crm_sync.upsert'))).toBe('Синхронизация с Bitrix (автоматически)');
    expect(auditActor(event({ event: 'orders.update', userId: null, username: null, source: null }))).toBe('Система');
  });

  it('applied: shows the corrected sum', () => {
    const summary = buildAuditReadableSummary(effect('crm_sync.payment_paid_reset_completed', {
      before: { phase: 'x', bitrixSum: 5000 },
      after: { phase: 'completed', outcome: 'applied', action: 'update', bitrixSum: 4000 },
    }));
    expect(summary.title).toBe('Bitrix: оплата обновлена');
    expect(summary.notes).toContain('Bitrix: сумма оплаты исправлена 5 000 → 4 000');
    expect(summary.changes[0]).toEqual({ label: 'Сумма оплаты в Bitrix', before: '5 000', after: '4 000' });
  });

  it('applied with missing sums does not break', () => {
    const summary = buildAuditReadableSummary(effect('crm_sync.payment_paid_reset_completed', { after: { outcome: 'applied' } }));
    expect(summary.notes).toContain('Bitrix: сумма оплаты исправлена — → —');
  });

  it('deleted and remote_missing', () => {
    const deleted = buildAuditReadableSummary(effect('crm_sync.payment_paid_reset_completed', { after: { outcome: 'deleted', action: 'delete' } }));
    expect(deleted.notes).toContain('Bitrix: оплата удалена');
    const missing = buildAuditReadableSummary(effect('crm_sync.payment_paid_reset_completed', { after: { outcome: 'remote_missing' } }));
    expect(missing.notes).toContain('Bitrix: оплата уже отсутствовала');
  });

  it('stuck and card events', () => {
    const stuck = buildAuditReadableSummary(effect('crm_sync.payment_paid_reset_stuck', { metadata: { error: 'timeout' } }));
    expect(stuck.title).toBe('Bitrix: не удалось обновить оплату');
    expect(stuck.notes).toContain('Ошибка: timeout');
    expect(buildAuditReadableSummary(effect('crm_sync.payment_card_closed')).notes).toContain('Bitrix: закрыта карточка «Поступила оплата»');
    const failed = buildAuditReadableSummary(effect('crm_sync.payment_card_close_failed', { metadata: { error: 'denied' } }));
    expect(failed.notes).toEqual(expect.arrayContaining(['Bitrix: не удалось закрыть карточку оплаты', 'Ошибка: denied']));
    expect(buildAuditReadableSummary(effect('crm_sync.payment_card_close_requested')).notes).toContain('Bitrix: запрошено закрытие карточки оплаты');
  });

  it('payment notifications: comment, bell, warning and skip reason', () => {
    const sent = buildAuditReadableSummary(effect('crm_sync.payment_notification_sent', {
      entityType: 'order',
      after: { status: 'sent', commentState: 'created', notifyState: 'no_scope' },
      metadata: { notifyOutcome: 'no_scope', syncIncomplete: true },
    }));
    expect(sent.title).toBe('Bitrix: менеджер уведомлён об изменении оплат');
    expect(sent.notes).toEqual(expect.arrayContaining([
      'Комментарий в сделке: добавлен',
      'Уведомление ответственному: нет права «Чат и уведомления» у вебхука',
      'Оплата в Bitrix к этому моменту ещё не была обновлена',
    ]));
    const skipped = buildAuditReadableSummary(effect('crm_sync.payment_notification_skipped', { entityType: 'order', metadata: { skipReason: 'no_deal' } }));
    expect(skipped.notes).toContain('Bitrix: у заказа нет сделки — уведомление не отправлено');
    const failed = buildAuditReadableSummary(effect('crm_sync.payment_notification_failed', {
      entityType: 'order', after: { commentState: 'unknown', notifyState: 'failed' }, metadata: { notifyOutcome: 'failed' },
    }));
    expect(failed.title).toBe('Bitrix: не удалось уведомить менеджера');
    expect(failed.notes).toEqual(expect.arrayContaining(['Комментарий в сделке: не удалось подтвердить', 'Уведомление ответственному: не отправлено']));
  });

  it('titles crm_sync upsert/delete by entity type', () => {
    expect(buildAuditReadableSummary(effect('crm_sync.upsert')).title).toBe('Оплата отправлена в Bitrix');
    expect(buildAuditReadableSummary(effect('crm_sync.delete')).title).toBe('Оплата удалена в Bitrix');
    expect(buildAuditReadableSummary(effect('crm_sync.upsert', { entityType: 'order' })).title).toBe('Синхронизирована запись CRM');
  });
});

describe('orders.update without diff', () => {
  it('says order rows changed instead of "изменено → изменено"', () => {
    const summary = buildAuditReadableSummary(event({ event: 'orders.update', before: { details: [{ id: 1 }] }, after: { details: [{ id: 2 }] }, diff: {} }));
    expect(summary.changes).toEqual([]);
    expect(summary.notes).toContain('Изменены строки заказа');
  });
});
