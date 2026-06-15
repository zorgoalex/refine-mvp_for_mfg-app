import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import type { AuditLogEventDto } from '../../api/types/auditApi.types';
import { buildAuditQuery, RelatedIds, ContextBlock, isRowExpandable } from './list';

function event(overrides: Partial<AuditLogEventDto> = {}): AuditLogEventDto {
  return {
    auditId: 'a1',
    event: 'org.direction_head_added',
    entityType: 'direction',
    entityId: '5',
    userId: 1,
    username: 'admin',
    role: 'admin',
    source: 'backend-org-command',
    relatedOrderId: null,
    relatedClientId: null,
    relatedPaymentId: null,
    relatedDeadlineId: null,
    relatedProductionEventId: null,
    relatedUserId: null,
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
    expect(q).toMatchObject({ page: 1, pageSize: 50, role: 'admin', relatedUserId: 158 });
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
});

describe('RelatedIds', () => {
  it('renders a related user tag when relatedUserId is set', () => {
    const html = renderToString(<RelatedIds record={event({ relatedUserId: 158 })} />);
    expect(html).toContain('Пользователь #');
    expect(html).toContain('158');
    expect(html).toContain('ant-tag-cyan');
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
      />,
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
