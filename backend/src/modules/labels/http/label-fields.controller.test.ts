import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { LABEL_FIELD_CATALOG } from '../application/bazis-field-catalog';
import { LabelFieldsController } from './label-fields.controller';
import type { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const viewer: CurrentUser = {
  id: '100',
  username: 'viewer',
  role: 'viewer',
  roleId: 100,
  permissions: [],
};

describe('LabelFieldsController', () => {
  it('returns 503 when labels feature is disabled', async () => {
    const controller = new LabelFieldsController(fakeService(), runtime(false));

    await expect(controller.list({ user: { ...viewer, permissions: ['labels.view'] }, requestId: 'req-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('delegates labels.view permission and catalog reads to the labels service', async () => {
    const service = fakeService();
    const controller = new LabelFieldsController(service, runtime(true));

    await expect(controller.list({ user: { ...viewer, permissions: ['labels.view'] }, requestId: 'req-2' })).resolves.toEqual([
      ...LABEL_FIELD_CATALOG,
    ]);
    expect(service.listFields).toHaveBeenCalledWith({
      currentUser: { ...viewer, permissions: ['labels.view'] },
      requestId: 'req-2',
    });
  });
});

function fakeService() {
  return {
    listFields: vi.fn(async () => [...LABEL_FIELD_CATALOG]),
  } as never;
}

function runtime(enabled: boolean): LabelsRuntimeConfigService {
  return {
    getFeatureFlags: () => ({ labelsEnabled: enabled }),
  } as LabelsRuntimeConfigService;
}
