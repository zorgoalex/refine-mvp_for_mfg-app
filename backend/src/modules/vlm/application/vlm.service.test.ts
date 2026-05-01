import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { VlmService } from './vlm.service';
import type { VlmProviderPort } from './vlm.types';

describe('VlmService', () => {
  it('requires vlm.health.view for VLM health', async () => {
    const service = new VlmService({ provider: createProvider() });

    await expect(
      service.getHealth({ currentUser: currentUser('manager') }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['vlm.health.view'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates health with detailsVisible for privileged user', async () => {
    const calls: string[] = [];
    const service = new VlmService({
      provider: createProvider({
        async getHealth(command) {
          calls.push(`health:${command.currentUser.id}:${command.detailsVisible}`);
          return { status: 'ok', detailsVisible: command.detailsVisible };
        },
      }),
    });

    await expect(
      service.getHealth({ currentUser: currentUser('admin', 'admin-1') }),
    ).resolves.toEqual({ status: 'ok', detailsVisible: true });
    expect(calls).toEqual(['health:admin-1:true']);
  });

  it('requires vlm.use before upload and analyze', async () => {
    const service = new VlmService({ provider: createProvider() });

    await expect(
      service.uploadImage({
        currentUser: currentUser('viewer'),
        dto: { file: { mimetype: 'image/png', size: 10 }, purpose: 'vlm' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['vlm.use'] },
    } satisfies Partial<ApiError>);

    await expect(
      service.analyzeImage({
        currentUser: currentUser('viewer'),
        dto: { uploadId: 'upl_1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['vlm.use'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates upload and analyze for vlm.use users', async () => {
    const calls: string[] = [];
    const service = new VlmService({
      provider: createProvider({
        async uploadImage(command) {
          calls.push(`upload:${command.currentUser.id}:${command.dto.purpose}`);
          return {
            success: true,
            uploadId: 'upl_1',
            url: 'https://files.example/upl_1.png',
            key: 'upl_1.png',
            size: 10,
            contentType: 'image/png',
          };
        },
        async analyzeImage(command) {
          calls.push(`analyze:${command.currentUser.id}:${command.dto.uploadId}`);
          return { success: true, uploadId: command.dto.uploadId, result: { items: [] } };
        },
      }),
    });

    await service.uploadImage({
      currentUser: currentUser('manager', 'manager-1'),
      dto: { file: { mimetype: 'image/png', size: 10 }, purpose: 'vlm' },
    });
    await service.analyzeImage({
      currentUser: currentUser('manager', 'manager-1'),
      dto: { uploadId: 'upl_1' },
    });
    expect(calls).toEqual(['upload:manager-1:vlm', 'analyze:manager-1:upl_1']);
  });
});

function createProvider(overrides: Partial<VlmProviderPort> = {}): VlmProviderPort {
  return {
    async getHealth() {
      throw new Error('getHealth should not be called');
    },
    async uploadImage() {
      throw new Error('uploadImage should not be called');
    },
    async analyzeImage() {
      throw new Error('analyzeImage should not be called');
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role'], id = `${role}-id`): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}
