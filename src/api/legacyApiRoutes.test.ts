import { describe, expect, it } from 'vitest';
import { legacyApiRoutes } from './legacyApiRoutes';

const legacyRoot = '/api';
const legacy = (path: string) => `${legacyRoot}${path}`;

describe('legacyApiRoutes', () => {
  it('centralizes rollback-only Vercel endpoints', () => {
    expect(legacyApiRoutes).toEqual({
      auth: {
        login: legacy('/login'),
        refresh: legacy('/refresh'),
      },
      users: {
        create: legacy('/users/create'),
        changePassword: legacy('/users/change-password'),
      },
      vlm: {
        health: legacy('/vlm/health'),
        upload: legacy('/vlm/upload'),
        analyze: legacy('/vlm/analyze'),
      },
      orderExport: {
        toDrive: legacy('/order-export-to-drive'),
      },
    });
  });

  it('does not contain backend versioned endpoints', () => {
    expect(JSON.stringify(legacyApiRoutes)).not.toContain(legacy('/v1/'));
  });
});
