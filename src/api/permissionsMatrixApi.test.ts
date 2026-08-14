import { describe, expect, it, vi } from 'vitest';
import { apiRoutes } from './apiRoutes';
import { permissionsMatrixApi } from './permissionsMatrixApi';
import { httpClient } from './httpClient';

vi.mock('./httpClient', () => ({
  httpClient: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
  },
}));

describe('permissionsMatrixApi', () => {
  it('uses backend permissions matrix routes', async () => {
    vi.mocked(httpClient.get).mockResolvedValueOnce({ version: 1 });
    await permissionsMatrixApi.get();
    expect(httpClient.get).toHaveBeenCalledWith('/api/v1/permissions/roles-matrix');
    expect(apiRoutes.permissions.resetRoleToDefaults(11)).toBe('/api/v1/permissions/roles/11/reset-to-defaults');
  });

  it('sends whole matrix with expected version', async () => {
    vi.mocked(httpClient.put).mockResolvedValueOnce({ version: 2 });
    await permissionsMatrixApi.update({
      version: 1,
      rolePermissions: { '11': { 'payments.view': true } },
      roleScopes: { '11': { 'payments.view': 'own' } },
      confirmDangerous: true,
    });
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/permissions/roles-matrix', {
      version: 1,
      rolePermissions: { '11': { 'payments.view': true } },
      roleScopes: { '11': { 'payments.view': 'own' } },
      confirmDangerous: true,
    });
  });
});
