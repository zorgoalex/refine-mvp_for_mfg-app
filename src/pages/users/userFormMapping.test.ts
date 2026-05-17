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
        username: 'operator_user',
        email: 'operator@example.test',
        role: 'operator',
        full_name: 'Operator User',
        is_active: true,
      }),
    ).toEqual({
      username: 'operator_user',
      email: 'operator@example.test',
      full_name: 'Operator User',
      is_active: true,
      role_id: 11,
    });
  });

  it('maps existing legacy role_id records to form role names while canonical role strings stay canonical', () => {
    expect(
      mapUserRecordToFormData({
        user_id: 11,
        username: 'operator_user',
        role_id: 11,
      }),
    ).toMatchObject({
      user_id: 11,
      username: 'operator_user',
      role: 'operator',
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
});
