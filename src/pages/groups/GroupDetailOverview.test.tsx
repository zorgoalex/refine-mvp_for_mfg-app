import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  GroupDeadlineStatusCountsResponse,
  GroupOverviewResponse,
} from '../../api/types/groupApi.types';
import { GroupDetailOverview } from './GroupDetailOverview';

const overviewFixture: GroupOverviewResponse = {
  group: {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'P7',
    name: 'P7 Overview',
    description: 'Read-only aggregate view',
    status: 'active',
    startsAt: '2026-06-01',
    endsAt: '2026-06-30',
    ownerUserId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    archivedAt: null,
  },
  orders: {
    totalCount: 2,
    statusCounts: [{ statusId: 1, statusName: 'New', orderCount: 2 }],
    relationCounts: [{ relationType: 'main', isPrimary: true, orderCount: 2 }],
    createdMonthCounts: [{ month: '2026-06-01', orderCount: 2 }],
  },
  linkedEntityCounts: [
    { entityType: 'order', currentCount: 2 },
    { entityType: 'client', currentCount: 1 },
  ],
  participants: {
    currentSummary: [
      { roleCode: 'manager', roleLabel: 'Manager', participantCount: 1 },
      { roleCode: 'observer', roleLabel: 'Observer', participantCount: 2 },
    ],
  },
  filter: {
    groupId: '11111111-1111-4111-8111-111111111111',
    temporalMode: 'current',
  },
  omitted: [
    'finance',
    'payments',
    'clientPhones',
    'audit',
    'deadline',
    'production',
    'members',
    'users',
    'orderDetails',
    'activityTimeline',
  ],
};

const deadlineStatusCounts: GroupDeadlineStatusCountsResponse = {
  data: [{ deadlineStatus: 'overdue', deadlineCount: 1 }],
  filter: {
    groupMode: 'any',
    groupIds: [overviewFixture.group.id],
    temporalMode: 'current',
  },
};

describe('GroupDetailOverview', () => {
  it('renders accepted aggregate overview fields without omitted domain labels', () => {
    const html = renderToString(
      <GroupDetailOverview overview={overviewFixture} deadlineStatusCounts={deadlineStatusCounts} />,
    );

    expect(html).toContain('P7 Overview');
    expect(html).toContain('P7');
    expect(html).toContain('Read-only aggregate view');
    expect(html).toContain('2');
    expect(html).toContain('New');
    expect(html).toContain('main');
    expect(html).toContain('2026-06-01');
    expect(html).toContain('Связанные сущности');
    expect(html).toContain('client');
    expect(html).toContain('Участники');
    expect(html).toContain('Manager');
    expect(html).toContain('Deadline status counts');
    expect(html).toContain('overdue');
    expect(html).not.toMatch(
      /payment|production detail|audit|finance|member detail|user detail|client phone|order details|activity timeline/i,
    );
  });
});
