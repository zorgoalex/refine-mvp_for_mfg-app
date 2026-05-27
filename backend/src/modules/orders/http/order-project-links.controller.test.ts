import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderProjectLinkService } from '../application/order-project-link.service';
import type {
  OrderProjectsResponseDto,
  ReplaceOrderProjectsResponseDto,
} from '../dto/order-project-link.dto';
import type { ProjectsRuntimeConfigService } from '../../projects/projects-runtime-config.service';
import { OrderProjectLinksController, parseReplaceOrderProjectsRequest } from './order-project-links.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const PROJECT_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

describe('OrderProjectLinksController', () => {
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

  it('fails GET closed when projects are disabled', async () => {
    const controller = createController({
      projectsFlags: { projectsEnabled: false, projectsReadOnly: false },
    });

    await expect(controller.get({ user: currentUser(), requestId: 'req-1' }, '15')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects' },
    } satisfies Partial<ApiError>);
  });

  it('fails PUT closed when projects are disabled or read-only', async () => {
    await expect(createController({
      projectsFlags: { projectsEnabled: false, projectsReadOnly: false },
    }).replace(
      { user: currentUser(), requestId: 'req-1' },
      '15',
      replaceBody(),
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects' },
    } satisfies Partial<ApiError>);

    await expect(createController({
      projectsFlags: { projectsEnabled: true, projectsReadOnly: true },
    }).replace(
      { user: currentUser(), requestId: 'req-1' },
      '15',
      replaceBody(),
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects', readOnly: true },
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
  projectsFlags?: { projectsEnabled: boolean; projectsReadOnly: boolean };
  links?: Partial<OrderProjectLinkService>;
} = {}): OrderProjectLinksController {
  const links = {
    async get() {
      return orderProjectsResponse();
    },
    async replace() {
      return replaceProjectsResponse();
    },
    ...options.links,
  } as unknown as OrderProjectLinkService;
  const ordersRuntimeConfig = {
    getFeatureFlags() {
      return options.ordersFlags ?? { ordersEnabled: true, ordersReadOnly: false };
    },
  } as OrdersRuntimeConfigService;
  const projectsRuntimeConfig = {
    getFeatureFlags() {
      return options.projectsFlags ?? { projectsEnabled: true, projectsReadOnly: false };
    },
  } as ProjectsRuntimeConfigService;

  return new OrderProjectLinksController(links, ordersRuntimeConfig, projectsRuntimeConfig);
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
