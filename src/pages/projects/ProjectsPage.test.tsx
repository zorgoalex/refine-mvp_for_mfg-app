import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyFeatureFlags, getFeatureFlags } from '../../config/featureFlags';
import type {
  ProjectDeadlineStatusCountsResponse,
  ProjectOverviewResponse,
} from '../../api/types/groupApi.types';
import {
  ProjectsPage,
  getMatchingDeadlineStatusCounts,
  getNextOverviewSelectionState,
  type OverviewSelectionState,
} from './ProjectsPage';
import { upsertParticipant } from './ProjectParticipantsPanel';

vi.mock('@refinedev/core', () => ({
  useGetIdentity: () => ({ data: mockIdentity }),
}));

describe('ProjectsPage', () => {
  const projectFixture = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'PRJ-001',
    name: 'Project',
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

  const defaultFlags = { ...getFeatureFlags({}), useBackendProjects: true };

  it('renders a minimal project list with create and archive controls', () => {
    mockIdentityPermissions(['projects.view', 'projects.create', 'projects.archive']);
    applyFeatureFlags({
      ...defaultFlags,
      useBackendPermissions: false,
    });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
      />,
    );

    expect(html).toContain('Проекты');
    expect(html).toContain('Код проекта');
    expect(html).toContain('Название');
    expect(html).toContain('Создать');
    expect(html).toContain('Обзор');
    expect(html).toContain('Архивировать');
    expect(html).not.toContain('Архив</span>');
  });

  it('hides project overview action when backend permissions lack orders.view', () => {
    mockIdentityPermissions(['projects.view', 'projects.create', 'projects.archive']);
    applyFeatureFlags({
      ...defaultFlags,
      useBackendPermissions: true,
    });

    const html = renderToString(<ProjectsPage initialProjects={[projectFixture]} />);

    expect(html).toContain('Проекты');
    expect(html).not.toContain('Обзор');
    expect(html).toContain('Архивировать');
  });

  it('renders project entity links with accepted backend permissions', () => {
    mockIdentityPermissions(['projects.view', 'orders.view', 'projects.manage_links']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialEntityLinks={{
          projectId: projectFixture.id,
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
    mockIdentityPermissions(['projects.view', 'orders.view', 'projects.manage_links']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialEntityLinks={{
          projectId: projectFixture.id,
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
    mockIdentityPermissions(['projects.view', 'orders.view', 'projects.participants.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialParticipants={{
          projectId: projectFixture.id,
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

    expect(html).toContain('Участники проекта');
    expect(html).toContain('employee');
    expect(html).toContain('Engineer A');
    expect(html).toContain('Observer');
  });

  it('does not show participant replace form until participants are loaded', () => {
    mockIdentityPermissions([
      'projects.view',
      'orders.view',
      'projects.participants.view',
      'projects.participants.manage',
    ]);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialParticipants={null}
        initialParticipantRoles={{ requestId: 'req-roles', roles: [{ code: 'observer', label: 'Observer' }] }}
      />,
    );

    expect(html).toContain('Участники проекта');
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
    mockIdentityPermissions(['projects.view', 'orders.view', 'deadlines.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts(projectFixture.id)}
      />,
    );

    expect(html).toContain('Deadline status counts');
    expect(html).toContain('overdue');
  });

  it('does not render injected deadline status counts without deadlines.view', () => {
    mockIdentityPermissions(['projects.view', 'orders.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts(projectFixture.id)}
      />,
    );

    expect(html).not.toContain('Deadline status counts');
    expect(html).not.toContain('overdue');
  });

  it('does not render injected deadline status counts for another project', () => {
    mockIdentityPermissions(['projects.view', 'orders.view', 'deadlines.view']);
    applyFeatureFlags({ ...defaultFlags, useBackendPermissions: true });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[projectFixture]}
        initialOverview={createOverviewFixture(projectFixture.id, projectFixture.name)}
        initialDeadlineStatusCounts={createDeadlineStatusCounts('22222222-2222-4222-8222-222222222222')}
      />,
    );

    expect(html).not.toContain('Deadline status counts');
    expect(html).not.toContain('overdue');
  });

  it('matches deadline status counts only to the selected project id', () => {
    const response = createDeadlineStatusCounts('22222222-2222-4222-8222-222222222222');
    const multiProjectResponse: ProjectDeadlineStatusCountsResponse = {
      ...createDeadlineStatusCounts(projectFixture.id),
      filter: {
        projectMode: 'any',
        projectIds: [projectFixture.id, '22222222-2222-4222-8222-222222222222'],
        temporalMode: 'current',
      },
    };

    expect(getMatchingDeadlineStatusCounts(projectFixture.id, response)).toBeNull();
    expect(getMatchingDeadlineStatusCounts('22222222-2222-4222-8222-222222222222', response)).toBe(response);
    expect(getMatchingDeadlineStatusCounts(projectFixture.id, multiProjectResponse)).toBeNull();
    expect(getMatchingDeadlineStatusCounts(projectFixture.id, null)).toBeNull();
  });

  it('keeps the latest selected overview when requests resolve out of order', () => {
    const initialState: OverviewSelectionState = {
      activeRequestId: 0,
      loadingProjectId: null,
      overview: null,
    };

    const firstLoadingState = getNextOverviewSelectionState(initialState, {
      type: 'request',
      projectId: '11111111-1111-4111-8111-111111111111',
    });
    const secondLoadingState = getNextOverviewSelectionState(firstLoadingState, {
      type: 'request',
      projectId: '22222222-2222-4222-8222-222222222222',
    });
    const secondLoadedState = getNextOverviewSelectionState(secondLoadingState, {
      type: 'success',
      requestId: secondLoadingState.activeRequestId,
      overview: createOverviewFixture('22222222-2222-4222-8222-222222222222', 'Project B'),
    });
    const staleFirstState = getNextOverviewSelectionState(secondLoadedState, {
      type: 'success',
      requestId: firstLoadingState.activeRequestId,
      overview: createOverviewFixture('11111111-1111-4111-8111-111111111111', 'Project A'),
    });

    expect(staleFirstState.overview?.project.name).toBe('Project B');
    expect(staleFirstState.loadingProjectId).toBeNull();
  });

  it('does not reopen overview when a pending request resolves after close', () => {
    const loadingState = getNextOverviewSelectionState(
      {
        activeRequestId: 0,
        loadingProjectId: null,
        overview: null,
      },
      {
        type: 'request',
        projectId: '11111111-1111-4111-8111-111111111111',
      },
    );

    const closedState = getNextOverviewSelectionState(loadingState, { type: 'close' });
    const lateSuccessState = getNextOverviewSelectionState(closedState, {
      type: 'success',
      requestId: loadingState.activeRequestId,
      overview: createOverviewFixture('11111111-1111-4111-8111-111111111111', 'Closed Project'),
    });

    expect(lateSuccessState.overview).toBeNull();
    expect(lateSuccessState.loadingProjectId).toBeNull();
  });
});

function createOverviewFixture(projectId: string, name: string): ProjectOverviewResponse {
  return {
    project: {
      id: projectId,
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
      projectId,
      temporalMode: 'current',
    },
    omitted: [],
  };
}

function createDeadlineStatusCounts(projectId: string): ProjectDeadlineStatusCountsResponse {
  return {
    data: [{ deadlineStatus: 'overdue', deadlineCount: 1 }],
    filter: {
      projectMode: 'any',
      projectIds: [projectId],
      temporalMode: 'current',
    },
  };
}

let mockIdentity = {
  id: '1',
  username: 'admin',
  role: 'admin',
  permissions: ['projects.view', 'projects.create', 'projects.archive'],
};

function mockIdentityPermissions(permissions: string[]): void {
  mockIdentity = {
    id: '1',
    username: 'admin',
    role: 'admin',
    permissions,
  };
}
