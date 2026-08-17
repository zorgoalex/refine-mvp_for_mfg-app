import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  RolesMatrixDto,
  UpdateRolesMatrixRequest,
} from './types/permissionsMatrixApi.types';

export const permissionsMatrixApi = {
  get(): Promise<RolesMatrixDto> {
    return httpClient.get<RolesMatrixDto>(apiRoutes.permissions.rolesMatrix);
  },

  update(request: UpdateRolesMatrixRequest): Promise<RolesMatrixDto> {
    return httpClient.put<RolesMatrixDto>(apiRoutes.permissions.rolesMatrix, request);
  },

  resetRoleToDefaults(roleId: number): Promise<RolesMatrixDto> {
    return httpClient.post<RolesMatrixDto>(
      apiRoutes.permissions.resetRoleToDefaults(validateRoleId(roleId)),
    );
  },
};

function validateRoleId(roleId: number): number {
  if (!Number.isInteger(roleId) || roleId <= 0) {
    throw new Error('Invalid roleId');
  }
  return roleId;
}
