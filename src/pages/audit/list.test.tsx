import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditLogEventDto } from '../../api/types/auditApi.types';
import { buildAuditQuery, RelatedIds, ContextBlock, ReadableAuditEvent, isRowExpandable } from './list';

function event(overrides: Partial<AuditLogEventDto> = {}): AuditLogEventDto {
  return {
    auditId: 'a1',
    event: 'org.direction_head_added',
    entityType: 'direction',
    entityId: '5',
    entityName: null,
    entityDetailNumber: null,
    userId: 1,
    username: 'admin',
    role: 'admin',
    source: 'backend-org-command',
    relatedOrderId: null,
    relatedOrderName: null,
    relatedClientId: null,
    relatedClientName: null,
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
    requestId: 'req1',
    ip: null,
    userAgent: null,
    before: null,
    after: null,
    diff: null,
    metadata: null,
    createdAt: '2026-06-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildAuditQuery', () => {
  it('includes role and relatedUserId filters', () => {
    const q = buildAuditQuery({ role: 'admin', relatedUserId: 158 }, 50);
    expect(q).toMatchObject({
      page: 1,
      pageSize: 50,
      role: 'admin',
      relatedUserId: 158,
    });
  });

  it('converts createdFrom/createdTo Dayjs to ISO strings', () => {
    const from = dayjs('2026-01-01T00:00:00.000Z');
    const to = dayjs('2026-12-31T23:59:59.000Z');
    const q = buildAuditQuery({ createdFrom: from, createdTo: to }, 20);
    expect(q.createdFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(q.createdTo).toBe('2026-12-31T23:59:59.000Z');
  });

  it('omits empty/undefined values', () => {
    const q = buildAuditQuery({ role: '', relatedUserId: undefined }, 50);
    expect(q).toEqual({ page: 1, pageSize: 50 });
  });

  it('maps business-history multi-select filters and RangePicker period', () => {
    const from = dayjs('2026-01-01T00:00:00.000Z');
    const to = dayjs('2026-01-02T00:00:00.000Z');
    const q = buildAuditQuery(
      {
        events: ['orders.update', 'payments.create'],
        orderIds: [2678],
        participantUserIds: [7, 8],
        createdRange: [from, to],
      },
      50,
      'business',
    );
    expect(q).toEqual({
      page: 1,
      pageSize: 50,
      scope: 'business',
      events: ['orders.update', 'payments.create'],
      orderIds: [2678],
      participantUserIds: [7, 8],
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('Journals source guards', () => {
  it('keeps a single journals page with business history and technical audit tabs', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'list.tsx'), 'utf8');

    expect(source).toContain("className=\"journals-top-tabs\"");
    expect(source).toContain("label: 'История бизнеса'");
    expect(source).toContain("label: 'Технический аудит'");
    expect(source).toContain("className=\"technical-audit-tabs\"");
    expect(source).toContain("label: 'Действия ERP'");
    expect(source).toContain("label: 'Telegram-бот'");
  });

  it('keeps business history filters visible, scoped and multi-select based', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'list.tsx'), 'utf8');

    expect(source).toContain("mode === 'business-history'");
    expect(source).toContain("scope: 'business'");
    expect(source).toContain('DatePicker.RangePicker');
    expect(source).toContain('name="events"');
    expect(source).toContain('name="orderIds"');
    expect(source).toContain('name="participantUserIds"');
    expect(source.match(/mode="multiple"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('does not expose technical view controls in business history mode', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'list.tsx'), 'utf8');

    expect(source).toContain('!businessHistoryMode && (');
    expect(source).toContain("businessHistoryMode || viewMode === 'readable'");
    expect(source).toContain("businessHistoryMode ? 'Нет записей истории бизнеса' : 'Нет записей аудита'");
  });
});

describe('RelatedIds', () => {
  it('renders a related user tag when relatedUserId is set', () => {
    const html = renderToString(<RelatedIds record={event({ relatedUserId: 158 })} />);
    expect(html).toContain('Пользователь #');
    expect(html).toContain('158');
    expect(html).toContain('ant-tag-cyan');
  });

  it('renders order, client and detail labels with names and position numbers', () => {
    const html = renderToString(
      <RelatedIds
        record={event({
          relatedOrderId: 11472,
          relatedOrderName: '2729',
          relatedClientId: 55,
          relatedClientName: 'Иван Петров',
          relatedEntities: [{ entityType: 'order_detail', entityId: 1001, detailNumber: 3 }],
        })}
      />
    );

    expect(html).toContain('Заказ 2729 (#11472)');
    expect(html).toContain('Клиент Иван Петров (#55)');
    expect(html).toContain('Деталь №3 (#1001)');
  });

  it('renders a dash when no related ids are present', () => {
    const html = renderToString(<RelatedIds record={event()} />);
    expect(html).toContain('—');
    expect(html).not.toContain('Пользователь #');
  });
});

describe('isRowExpandable', () => {
  it('is true when only stage_code is present (matches ContextBlock visibility)', () => {
    expect(isRowExpandable(event({ stageCode: 'S3' }))).toBe(true);
  });
  it('is true when only status_name/status_code are present', () => {
    expect(isRowExpandable(event({ statusName: 'Готов', statusCode: 'READY' }))).toBe(true);
  });
  it('is true on ip/userAgent or JSON blobs', () => {
    expect(isRowExpandable(event({ ip: '10.0.0.1' }))).toBe(true);
    expect(isRowExpandable(event({ after: { a: 1 } }))).toBe(true);
  });
  it('is false when nothing expandable is present', () => {
    expect(isRowExpandable(event())).toBe(false);
  });
});

describe('ContextBlock', () => {
  it('renders status, ip and user_agent dimensions', () => {
    const html = renderToString(
      <ContextBlock
        record={event({
          statusField: 'order_status',
          statusName: 'Готов к выдаче',
          statusCode: 'READY',
          stageCode: 'S3',
          ip: '10.0.0.5',
          userAgent: 'Mozilla/5.0',
        })}
      />
    );
    expect(html).toContain('status_name');
    expect(html).toContain('Готов к выдаче');
    expect(html).toContain('ip');
    expect(html).toContain('10.0.0.5');
    expect(html).toContain('user_agent');
    expect(html).toContain('Mozilla/5.0');
  });

  it('renders nothing when no context dimensions are present', () => {
    const html = renderToString(<ContextBlock record={event()} />);
    expect(html).toBe('');
  });
});

describe('ReadableAuditEvent', () => {
  it('renders a non-technical status-change description with actor and before/after values', () => {
    const html = renderToString(
      <ReadableAuditEvent
        record={event({
          event: 'orders.status_change',
          relatedOrderId: 42,
          relatedOrderName: '2728',
          statusField: 'orderStatus',
          statusId: 2,
          statusName: 'Готов к выдаче',
          before: { orderStatusId: 1 },
          after: { orderStatusId: 2, orderStatusName: 'Готов к выдаче' },
          diff: { orderStatusId: { before: 1, after: 2 } },
        })}
      />
    );

    expect(html).toContain('Изменён статус заказа');
    expect(html).toContain('Кем:');
    expect(html).toContain('admin (admin)');
    expect(html).toContain('Статус заказа');
    expect(html).toContain('#1');
    expect(html).toContain('Готов к выдаче');
    expect(html).not.toContain('Request ID');
    expect(html).not.toContain('req1');
  });
});
