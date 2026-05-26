import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectsPage } from './ProjectsPage';

describe('ProjectsPage', () => {
  it('renders a minimal project list with create and archive controls', () => {
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
    expect(html).toContain('Архивировать');
  });
});
