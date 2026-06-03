import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectOverviewResponse } from '../../api/types/projectApi.types';
import { ProjectDetailOverview } from './ProjectDetailOverview';

const overviewFixture: ProjectOverviewResponse = {
  project: {
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
  filter: {
    projectId: '11111111-1111-4111-8111-111111111111',
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

describe('ProjectDetailOverview', () => {
  it('renders accepted aggregate overview fields without omitted domain labels', () => {
    const html = renderToString(<ProjectDetailOverview overview={overviewFixture} />);

    expect(html).toContain('P7 Overview');
    expect(html).toContain('P7');
    expect(html).toContain('Read-only aggregate view');
    expect(html).toContain('2');
    expect(html).toContain('New');
    expect(html).toContain('main');
    expect(html).toContain('2026-06-01');
    expect(html).not.toMatch(
      /payment|deadline|production|audit|finance|member|user|client phone|order details|activity timeline/i,
    );
  });
});
