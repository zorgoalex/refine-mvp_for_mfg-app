import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyFeatureFlags, getFeatureFlags } from '../../config/featureFlags';
import type { ProjectOverviewResponse } from '../../api/types/projectApi.types';
import {
  ProjectsPage,
  getNextOverviewSelectionState,
  type OverviewSelectionState,
} from './ProjectsPage';

vi.mock('@refinedev/core', () => ({
  useGetIdentity: () => ({ data: { id: '1', username: 'admin', role: 'admin', permissions: ['projects.view', 'projects.create', 'projects.archive'] } }),
}));

describe('ProjectsPage', () => {
  it('renders a minimal project list with create and archive controls', () => {
    applyFeatureFlags({
      ...getFeatureFlags({}),
      useBackendProjects: true,
      useBackendPermissions: false,
    });

    const html = renderToString(
      <ProjectsPage
        initialProjects={[
          {
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
          },
        ]}
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
    filter: {
      projectId,
      temporalMode: 'current',
    },
    omitted: [],
  };
}
