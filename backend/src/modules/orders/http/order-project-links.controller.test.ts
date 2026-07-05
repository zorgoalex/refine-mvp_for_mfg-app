import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderGroupLinkService } from '../application/order-group-link.service';
import type {
  OrderProjectsResponseDto,
  ReplaceOrderProjectsResponseDto,
} from '../dto/order-project-link.dto';
import type { GroupsRuntimeConfigService } from '../../groups/groups-runtime-config.service';
import { OrderGroupLinksController, parseReplaceOrderProjectsRequest } from './order-group-links.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const PROJECT_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

describe('OrderGroupLinksController', () => {
  it('normalizes primary project id before cross-field validation', () => {
    expect(parseReplaceOrderProjectsRequest({
      idempotencyKey: 'mixed-case-primary',
      version: 3,
      primaryProjectId: PROJECT_ID.toUpperCase(),
      projects: [{ projectId: PROJECT_ID, relationType: 'main', isPrimary: false }],
    })).toMatchObject({
      primaryProjectId: PROJECT_ID,
      projects: [{ projectId: PROJECT_ID, relationType: 'main', isPrimary: true }],
    });
  });

  it('fails GET closed when groups are disabled', async () => {
    const controller = createController({
      groupsFlags: { groupsEnabled: false, groupsReadOnly: false },
    });

    await expect(controller.get({ user: currentUser(), requestId: 'req-1' }, '15')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups' },
    } satisfies Partial<ApiError>);
  });

  it('fails PUT closed when groups are disabled or read-only', async () => {
    await expect(createController({
      groupsFlags: { groupsEnabled: false, groupsReadOnly: false },
    }).replace(
      { user: currentUser(), requestId: 'req-1' },
      '15',
      replaceBody(),
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups' },
    } satisfies Partial<ApiError>);

    await expect(createController({
      groupsFlags: { groupsEnabled: true, groupsReadOnly: true },
    }).replace(
      { user: currentUser(), requestId: 'req-1' },
      '15',
      replaceBody(),
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups', readOnly: true },
    } satisfies Partial<ApiError>);
  });

  it('rejects unsupported temporal GET query params without calling service', async () => {
    const calls: string[] = [];
    const controller = createController({
      links: {
        async get() {
          calls.push('get');
          return orderProjectsResponse();
        },
      },
    });

    await expect(controller.get(
      { user: currentUser(), requestId: 'req-1' },
      '15',
      { asOf: '2026-05-01T00:00:00.000Z' },
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        errors: [{ field: 'asOf', message: 'asOf is not supported for P1-P3 current project links' }],
      },
    } satisfies Partial<ApiError>);
    expect(calls).toEqual([]);
  });
});

function createController(options: {
  ordersFlags?: { ordersEnabled: boolean; ordersReadOnly: boolean };
  groupsFlags?: { groupsEnabled: boolean; groupsReadOnly: boolean };
  links?: Partial<OrderGroupLinkService>;
} = {}): OrderGroupLinksController {
  const links = {
    async get() {
      return orderProjectsResponse();
    },
    async replace() {
      return replaceProjectsResponse();
    },
    ...options.links,
  } as unknown as OrderGroupLinkService;
  const ordersRuntimeConfig = {
    getFeatureFlags() {
      return options.ordersFlags ?? { ordersEnabled: true, ordersReadOnly: false };
    },
  } as OrdersRuntimeConfigService;
  const groupsRuntimeConfig = {
    getFeatureFlags() {
      return options.groupsFlags ?? { groupsEnabled: true, groupsReadOnly: false };
    },
  } as GroupsRuntimeConfigService;

  return new OrderGroupLinksController(links, ordersRuntimeConfig, groupsRuntimeConfig);
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function replaceBody() {
  return {
    idempotencyKey: 'replace-projects-key',
    version: 3,
    primaryProjectId: PROJECT_ID,
    projects: [{ projectId: PROJECT_ID, relationType: 'main', isPrimary: true }],
  };
}

function orderProjectsResponse(): OrderProjectsResponseDto {
  return {
    orderId: 15,
    version: 3,
    primaryProject: null,
    projects: [],
    requestId: 'req-1',
  };
}

function replaceProjectsResponse(): ReplaceOrderProjectsResponseDto {
  return {
    ...orderProjectsResponse(),
    changed: false,
  };
}
