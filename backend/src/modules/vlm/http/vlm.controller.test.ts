import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { VlmService } from '../application/vlm.service';
import {
  parseVlmAnalyzeRequest,
  parseVlmUploadRequest,
  VlmController,
} from './vlm.controller';
import type { VlmRuntimeConfigService } from './vlm-runtime-config.service';

const uploadLimits = {
  maxUploadBytes: 20 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

describe('VlmController', () => {
  it('fails closed when VLM API feature flag is disabled by default', async () => {
    const controller = createController({
      flags: { vlmEnabled: false, vlmDisabled: true },
    });

    await expect(controller.health({ user: currentUser('admin') })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'vlm' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user when VLM is enabled', async () => {
    const controller = createController({
      flags: { vlmEnabled: true, vlmDisabled: false },
    });

    await expect(controller.health({})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('keeps upload/analyze disabled until BACKEND_VLM_DISABLED=false', async () => {
    const controller = createController({
      flags: { vlmEnabled: true, vlmDisabled: true },
    });

    await expect(
      controller.upload(
        { user: currentUser('manager') },
        { file: { mimetype: 'image/png', size: 10 } },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'vlm', mode: 'disabled' },
    } satisfies Partial<ApiError>);
  });

  it('delegates health, upload, and analyze with parsed DTOs', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: { vlmEnabled: true, vlmDisabled: false },
      service: {
        async getHealth(command) {
          calls.push(`health:${command.currentUser.id}`);
          return { status: 'ok', detailsVisible: true };
        },
        async uploadImage(command) {
          calls.push(
            `upload:${command.currentUser.id}:${command.dto.file.mimetype}:${command.dto.purpose}`,
          );
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
      },
    });

    await controller.health({ user: currentUser('admin', 'admin-1') });
    await controller.upload(
      { user: currentUser('manager', 'manager-1') },
      { file: { mimetype: 'image/png', size: 10 }, purpose: 'vlm' },
    );
    await controller.analyze(
      { user: currentUser('manager', 'manager-1') },
      { uploadId: 'upl_1', providerOrder: ['openai'] },
    );
    expect(calls).toEqual([
      'health:admin-1',
      'upload:manager-1:image/png:vlm',
      'analyze:manager-1:upl_1',
    ]);
  });

  it('validates upload MIME and size before provider call', () => {
    expect(
      parseVlmUploadRequest(
        { file: { mimetype: 'image/png', size: 20 }, purpose: 'order_file' },
        uploadLimits,
      ),
    ).toEqual({
      file: { mimetype: 'image/png', size: 20 },
      purpose: 'order_file',
    });
    expect(() =>
      parseVlmUploadRequest({ file: { mimetype: 'application/x-msdownload', size: 20 } }, uploadLimits),
    ).toThrow(ApiError);
    expect(() =>
      parseVlmUploadRequest(
        { file: { mimetype: 'image/png', size: uploadLimits.maxUploadBytes + 1 } },
        uploadLimits,
      ),
    ).toThrow(ApiError);
  });

  it('validates analyze request one-of contract', () => {
    expect(parseVlmAnalyzeRequest({ uploadId: 'upl_1' })).toEqual({ uploadId: 'upl_1' });
    expect(parseVlmAnalyzeRequest({ imageUrl: 'https://files.example/upl_1.png' })).toEqual({
      imageUrl: 'https://files.example/upl_1.png',
    });
    expect(() => parseVlmAnalyzeRequest({})).toThrow(ApiError);
    expect(() =>
      parseVlmAnalyzeRequest({ uploadId: 'upl_1', imageUrl: 'https://files.example/upl_1.png' }),
    ).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { vlmEnabled: boolean; vlmDisabled: boolean };
  service?: Partial<VlmService>;
}): VlmController {
  const service = {
    async getHealth() {
      throw new Error('getHealth should not be called');
    },
    async uploadImage() {
      throw new Error('uploadImage should not be called');
    },
    async analyzeImage() {
      throw new Error('analyzeImage should not be called');
    },
    ...options.service,
  } as unknown as VlmService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
    getUploadLimits() {
      return uploadLimits;
    },
  } as VlmRuntimeConfigService;

  return new VlmController(service, runtimeConfig);
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
