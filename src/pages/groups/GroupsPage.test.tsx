import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyFeatureFlags, getFeatureFlags } from '../../config/featureFlags';
import type {
  GroupDeadlineStatusCountsResponse,
  GroupOverviewResponse,
} from '../../api/types/groupApi.types';
import {
  GroupsPage,
  getMatchingDeadlineStatusCounts,
  getNextOverviewSelectionState,
  type OverviewSelectionState,
} from './GroupsPage';
import { upsertParticipant } from './GroupParticipantsPanel';

vi.mock('@refinedev/core', () => ({
  useGetIdentity: () => ({ data: mockIdentity }),
}));

describe('GroupsPage', () => {
  const groupFixture = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'PRJ-001',
    name: 'Group',
    description: null,
    status: 'active',
    startsAt: null,
    endsAt: null,
    ownerUserId: null,
    metadata: {},
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    archivedAt: null,
    createdBy: null,
  } as const;

  const defaultFlags = { ...getFeatureFlags({}), useBackendGroups: true };

  it('renders a minimal group list with create and archive controls', () => {
    mockIdentityPermissions(['groups.view', 'groups.create', 'groups.archive']);
    applyFeatureFlags({
      ...defaultFlags,
      useBackendPermissions: false,
    });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
      />,
    );

    expect(html).toContain('Группы');
    expect(html).toContain('Код группы');
    expect(html).toContain('Название');
    expect(html).toContain('Создать');
    expect(html).toContain('Обзор');
    expect(html).toContain('Архивировать');
    expect(html).not.toContain('Архив</span>');
  });

  it('hides group overview action when backend permissions lack orders.view', () => {
    mockIdentityPermissions(['groups.view', 'groups.create', 'groups.archive']);
    applyFeatureFlags({
      ...defaultFlags,
      useBackendPermissions: true,
    });

    const html = renderToString(<GroupsPage initialGroups={[groupFixture]} />);

    expect(html).toContain('Группы');
    expect(html).not.toContain('Обзор');
    expect(html).toContain('Архивировать');
  });

  it('renders group entity links with accepted backend permissions', () => {
    mockIdentityPermissions(['groups.view', 'orders.view', 'groups.manage_links']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialEntityLinks={{
          groupId: groupFixture.id,
          requestId: 'req-links',
          links: [{
            id: 'link-1',
            entityType: 'order',
            entityId: '11195',
            displayLabel: 'Заказ 11195',
            relationType: 'related',
            validFrom: '2026-06-06T00:00:00.000Z',
            validTo: null,
            metadata: {},
          }],
        }}
      />,
    );

    expect(html).toContain('Связанные сущности');
    expect(html).toContain('order');
    expect(html).toContain('Заказ 11195');
    expect(html).not.toMatch(/payment|finance|audit|client phone|order details/i);
  });

  it('filters entity link rows and add options by entity-specific permissions', () => {
    mockIdentityPermissions(['groups.view', 'orders.view', 'groups.manage_links']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialEntityLinks={{
          groupId: groupFixture.id,
          requestId: 'req-links',
          links: [
            {
              id: 'order-link',
              entityType: 'order',
              entityId: '11195',
              displayLabel: 'Заказ 11195',
              relationType: 'related',
              validFrom: '2026-06-06T00:00:00.000Z',
              validTo: null,
              metadata: {},
            },
            {
              id: 'deadline-link',
              entityType: 'deadline_instance',
              entityId: '11111111-1111-4111-8111-111111111111',
              displayLabel: 'Deadline private',
              relationType: 'related',
              validFrom: '2026-06-06T00:00:00.000Z',
              validTo: null,
              metadata: {},
            },
          ],
        }}
      />,
    );

    expect(html).toContain('Заказ 11195');
    expect(html).toContain('order');
    expect(html).not.toContain('Deadline private');
    expect(html).not.toContain('deadline_instance');
    expect(html).not.toContain('client');
  });

  it('renders typed participants when participants permission is present', () => {
    mockIdentityPermissions(['groups.view', 'orders.view', 'groups.participants.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialParticipants={{
          groupId: groupFixture.id,
          requestId: 'req-participants',
          participants: [{
            id: 'participant-1',
            participantType: 'employee',
            participantId: '11',
            displayName: 'Engineer A',
            role: { code: 'observer', label: 'Observer' },
            validFrom: '2026-06-06T00:00:00.000Z',
            validTo: null,
            metadata: {},
          }],
        }}
        initialParticipantRoles={{ requestId: 'req-roles', roles: [{ code: 'observer', label: 'Observer' }] }}
      />,
    );

    expect(html).toContain('Участники группы');
    expect(html).toContain('employee');
    expect(html).toContain('Engineer A');
    expect(html).toContain('Observer');
  });

  it('does not show participant replace form until participants are loaded', () => {
    mockIdentityPermissions([
      'groups.view',
      'orders.view',
      'groups.participants.view',
      'groups.participants.manage',
    ]);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialParticipants={null}
        initialParticipantRoles={{ requestId: 'req-roles', roles: [{ code: 'observer', label: 'Observer' }] }}
      />,
    );

    expect(html).toContain('Участники группы');
    expect(html).not.toContain('Сохранить участников');
  });

  it('blocks participant replacement when an existing participant id is unavailable', () => {
    expect(() =>
      upsertParticipant([
        {
          id: 'redacted',
          participantType: 'employee',
          participantId: null,
          displayName: 'Redacted',
          role: { code: 'observer', label: 'Observer' },
          validFrom: '2026-06-06T00:00:00.000Z',
          validTo: null,
          metadata: {},
        },
      ], {
        participantType: 'user',
        participantId: '158',
        roleCode: 'manager',
        metadata: {},
      }),
    ).toThrow('Cannot replace participants while a current participant id is unavailable');
  });

  it('renders deadline status counts only when deadline report permissions are present', () => {
    mockIdentityPermissions(['groups.view', 'orders.view', 'deadlines.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts(groupFixture.id)}
      />,
    );

    expect(html).toContain('Deadline status counts');
    expect(html).toContain('overdue');
  });

  it('does not render injected deadline status counts without deadlines.view', () => {
    mockIdentityPermissions(['groups.view', 'orders.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts(groupFixture.id)}
      />,
    );

    expect(html).not.toContain('Deadline status counts');
    expect(html).not.toContain('overdue');
  });

  it('does not render injected deadline status counts for another group', () => {
    mockIdentityPermissions(['groups.view', 'orders.view', 'deadlines.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <GroupsPage
        initialGroups={[groupFixture]}
        initialOverview={createOverviewFixture(groupFixture.id, groupFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts('22222222-2222-4222-8222-222222222222')}
      />,
    );

    expect(html).not.toContain('Deadline status counts');
    expect(html).not.toContain('overdue');
  });

  it('matches deadline status counts only to the selected group id', () => {
    const response = createDeadlineStatusCounts('22222222-2222-4222-8222-222222222222');
    const multiGroupResponse: GroupDeadlineStatusCountsResponse = {
      ...createDeadlineStatusCounts(groupFixture.id),
      filter: {
        groupMode: 'any',
        groupIds: [groupFixture.id, '22222222-2222-4222-8222-222222222222'],
        temporalMode: 'current',
      },
    };

    expect(getMatchingDeadlineStatusCounts(groupFixture.id, response)).toBeNull();
    expect(getMatchingDeadlineStatusCounts('22222222-2222-4222-8222-222222222222', response)).toBe(response);
    expect(getMatchingDeadlineStatusCounts(groupFixture.id, multiGroupResponse)).toBeNull();
    expect(getMatchingDeadlineStatusCounts(groupFixture.id, null)).toBeNull();
  });

  it('keeps the latest selected overview when requests resolve out of order', () => {
    const initialState: OverviewSelectionState = {
      activeRequestId: 0,
      loadingGroupId: null,
      overview: null,
    };

    const firstLoadingState = getNextOverviewSelectionState(initialState, {
      type: 'request',
      groupId: '11111111-1111-4111-8111-111111111111',
    });
    const secondLoadingState = getNextOverviewSelectionState(firstLoadingState, {
      type: 'request',
      groupId: '22222222-2222-4222-8222-222222222222',
    });
    const secondLoadedState = getNextOverviewSelectionState(secondLoadingState, {
      type: 'success',
      requestId: secondLoadingState.activeRequestId,
      overview: createOverviewFixture('22222222-2222-4222-8222-222222222222', 'Group B'),
    });
    const staleFirstState = getNextOverviewSelectionState(secondLoadedState, {
      type: 'success',
      requestId: firstLoadingState.activeRequestId,
      overview: createOverviewFixture('11111111-1111-4111-8111-111111111111', 'Group A'),
    });

    expect(staleFirstState.overview?.group.name).toBe('Group B');
    expect(staleFirstState.loadingGroupId).toBeNull();
  });

  it('does not reopen overview when a pending request resolves after close', () => {
    const loadingState = getNextOverviewSelectionState(
      {
        activeRequestId: 0,
        loadingGroupId: null,
        overview: null,
      },
      {
        type: 'request',
        groupId: '11111111-1111-4111-8111-111111111111',
      },
    );

    const closedState = getNextOverviewSelectionState(loadingState, { type: 'close' });
    const lateSuccessState = getNextOverviewSelectionState(closedState, {
      type: 'success',
      requestId: loadingState.activeRequestId,
      overview: createOverviewFixture('11111111-1111-4111-8111-111111111111', 'Closed Group'),
    });

    expect(lateSuccessState.overview).toBeNull();
    expect(lateSuccessState.loadingGroupId).toBeNull();
  });
});

function createOverviewFixture(groupId: string, name: string): GroupOverviewResponse {
  return {
    group: {
      id: groupId,
      code: name.replace(/\s+/g, '-').toUpperCase(),
      name,
      description: null,
      status: 'active',
      startsAt: null,
      endsAt: null,
      ownerUserId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      archivedAt: null,
    },
    orders: {
      totalCount: 1,
      statusCounts: [{ statusId: 1, statusName: 'New', orderCount: 1 }],
      relationCounts: [{ relationType: 'main', isPrimary: true, orderCount: 1 }],
      createdMonthCounts: [{ month: '2026-06-01', orderCount: 1 }],
    },
    linkedEntityCounts: [],
    participants: { currentSummary: [] },
    filter: {
      groupId,
      temporalMode: 'current',
    },
    omitted: [],
  };
}

function createDeadlineStatusCounts(groupId: string): GroupDeadlineStatusCountsResponse {
  return {
    data: [{ deadlineStatus: 'overdue', deadlineCount: 1 }],
    filter: {
      groupMode: 'any',
      groupIds: [groupId],
      temporalMode: 'current',
    },
  };
}

let mockIdentity = {
  id: '1',
  username: 'admin',
  role: 'admin',
  permissions: ['groups.view', 'groups.create', 'groups.archive'],
};

function mockIdentityPermissions(permissions: string[]): void {
  mockIdentity = {
    id: '1',
    username: 'admin',
    role: 'admin',
    permissions,
  };
}
