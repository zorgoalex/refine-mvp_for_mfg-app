import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@refinedev/core', () => ({
  useGetIdentity: () => ({ data: { permissions: ['org.view'] } }),
}));

vi.mock('../../../api/orgApi', () => ({
  orgApi: {
    listDirections: vi.fn().mockResolvedValue({ directions: [] }),
    getWorkshops: vi.fn().mockResolvedValue({ workshops: [] }),
    getWorkCenters: vi.fn().mockResolvedValue({ workCenters: [] }),
    getAssignableUsers: vi.fn().mockResolvedValue({ users: [] }),
  },
}));

import { OrgStructureConfig } from './OrgStructureConfig';

describe('OrgStructureConfig', () => {
  it('renders the directions panel for an org.view user and hides create without org.manage', () => {
    const html = renderToString(<OrgStructureConfig />);
    expect(html).toMatch(/Направлени/i);
    expect(html).not.toMatch(/Добавить направление/i);
  });

  it('shows the create control for an org.manage user', () => {
    const html = renderToString(
      <OrgStructureConfig initialPermissions={['org.view', 'org.manage']} />,
    );
    expect(html).toMatch(/Добавить направление/i);
  });
});
