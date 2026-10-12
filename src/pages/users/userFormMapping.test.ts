import { describe, expect, it } from 'vitest';
import {
  mapBackendCreateUserRequest,
  mapBackendUpdateUserRequest,
  mapLegacyUserFormToHasuraPayload,
  mapUserRecordToFormData,
} from './userFormMapping';

describe('user form mapping', () => {
  it('keeps canonical role names for backend create and update requests and never emits role_id', () => {
    const createRequest = mapBackendCreateUserRequest({
      username: 'operator_user',
      email: 'operator@example.test',
      password: 'secure-password',
      role: 'operator',
      full_name: 'Operator User',
      is_active: true,
    });

    expect(createRequest).toEqual({
      username: 'operator_user',
      email: 'operator@example.test',
      password: 'secure-password',
      role: 'operator',
      fullName: 'Operator User',
      isActive: true,
    });
    expect(createRequest).not.toHaveProperty('role_id');

    const updateRequest = mapBackendUpdateUserRequest({
      username: 'operator_user',
      email: 'operator@example.test',
      role: 'operator',
      full_name: '',
      is_active: false,
    });

    expect(updateRequest).toEqual({
      username: 'operator_user',
      email: 'operator@example.test',
      role: 'operator',
      fullName: null,
      isActive: false,
    });
    expect(updateRequest).not.toHaveProperty('role_id');
  });

  it('preserves create password exactly as typed', () => {
    const createRequest = mapBackendCreateUserRequest({
      username: 'operator_user',
      email: 'operator@example.test',
      password: '  secure-password  ',
      role: 'operator',
    });

    expect(createRequest.password).toBe('  secure-password  ');
  });

  it('uses role_id only for legacy Hasura update payloads', () => {
    expect(
      mapLegacyUserFormToHasuraPayload({
        username: 'packer_user',
        email: 'packer@example.test',
        role: 'packer',
        full_name: 'Packer User',
        is_active: true,
      }),
    ).toEqual({
      username: 'packer_user',
      email: 'packer@example.test',
      full_name: 'Packer User',
      is_active: true,
      role_id: 30,
    });
  });

  it('maps existing legacy role_id records to form role names while canonical role strings stay canonical', () => {
    expect(
      mapUserRecordToFormData({
        user_id: 30,
        username: 'packer_user',
        role_id: 30,
      }),
    ).toMatchObject({
      user_id: 30,
      username: 'packer_user',
      role: 'packer',
    });

    expect(
      mapUserRecordToFormData({
        id: 12,
        username: 'manager_user',
        role: 'manager',
        role_id: 11,
      }),
    ).toMatchObject({
      id: 12,
      username: 'manager_user',
      role: 'manager',
      role_id: 11,
    });
  });

  it('never writes the employee link through Hasura (legacy mode)', () => {
    expect(mapLegacyUserFormToHasuraPayload({ username: 'u1', role: 'viewer', employee_id: 7 })).not.toHaveProperty('employee_id');
  });

  it('links and unlinks the employee only when the form has the field', () => {
    expect(mapBackendUpdateUserRequest({ employee_id: 7 })).toMatchObject({ employeeId: 7 });
    expect(mapBackendUpdateUserRequest({ employee_id: null })).toMatchObject({ employeeId: null });
    // The row version of the loaded user goes with the save; an older backend that sends none — nothing is added.
    expect(mapBackendUpdateUserRequest({ full_name: 'X' }, 6)).toMatchObject({ expectedVersion: 6 });
    expect(mapBackendUpdateUserRequest({ full_name: 'X' }, null)).not.toHaveProperty('expectedVersion');
    expect(mapBackendUpdateUserRequest({ role: 'admin' })).not.toHaveProperty('employeeId');
    expect(mapBackendCreateUserRequest({ username: 'u1', password: 'secure-password', role: 'viewer', employee_id: 4 })).toMatchObject({ employeeId: 4 });
  });
});
