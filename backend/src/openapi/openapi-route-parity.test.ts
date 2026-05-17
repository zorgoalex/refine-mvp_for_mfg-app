import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const EXPECTED_BACKEND_V1_ROUTES = [
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'GET /api/v1/me',
  'GET /api/v1/orders',
  'POST /api/v1/orders',
  'GET /api/v1/orders/form-data',
  'GET /api/v1/orders/{orderId}',
  'PUT /api/v1/orders/{orderId}',
  'DELETE /api/v1/orders/{orderId}',
  'GET /api/v1/orders/{orderId}/audit',
  'POST /api/v1/orders/{orderId}/export/google-drive',
  'GET /api/v1/orders/{orderId}/snapshot',
  'GET /api/v1/orders/snapshot/batch',
  'POST /api/v1/orders/snapshot/import',
  'POST /api/v1/orders/snapshot/import-batch',
  'PATCH /api/v1/orders/{orderId}/calendar-date',
  'PATCH /api/v1/orders/{orderId}/status',
  'PATCH /api/v1/orders/{orderId}/order-status',
  'PUT /api/v1/orders/{orderId}/production-stage-events/{productionStatusId}',
  'DELETE /api/v1/orders/{orderId}/production-stage-events/{productionStatusId}',
  'POST /api/v1/payments',
  'PATCH /api/v1/payments/{paymentId}',
  'DELETE /api/v1/payments/{paymentId}',
  'POST /api/v1/client-phones',
  'PATCH /api/v1/client-phones/{phoneId}',
  'DELETE /api/v1/client-phones/{phoneId}',
  'GET /api/v1/users',
  'POST /api/v1/users',
  'GET /api/v1/users/{userId}',
  'PATCH /api/v1/users/{userId}',
  'POST /api/v1/users/{userId}/change-password',
  'PATCH /api/v1/users/{userId}/deactivate',
  'PATCH /api/v1/users/{userId}/activate',
  'GET /api/v1/vlm/health',
  'POST /api/v1/vlm/upload',
  'POST /api/v1/vlm/analyze',
  'GET /api/v1/orders/{orderId}/deadlines',
  'GET /api/v1/orders/{orderId}/deadline-events',
  'GET /api/v1/orders/{orderId}/deadline-summary',
  'GET /api/v1/deadlines',
  'GET /api/v1/deadlines/{deadlineId}',
  'POST /api/v1/deadlines',
  'PATCH /api/v1/deadlines/{deadlineId}',
  'POST /api/v1/deadlines/{deadlineId}/pause',
  'POST /api/v1/deadlines/{deadlineId}/resume',
  'POST /api/v1/deadlines/{deadlineId}/cancel',
  'GET /api/v1/deadline-policies',
  'POST /api/v1/deadline-policies',
  'PATCH /api/v1/deadline-policies/{policyId}',
  'GET /api/v1/deadline-settings',
  'PATCH /api/v1/deadline-settings',
] as const;

describe('OpenAPI static contract route parity', () => {
  it('documents every implemented backend-owned /api/v1 route', () => {
    const contract = readOpenApiContract();
    const documentedRoutes = collectDocumentedRoutes(contract);

    expect(documentedRoutes.sort()).toEqual([...EXPECTED_BACKEND_V1_ROUTES].sort());
  });
});

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function collectDocumentedRoutes(contract: string): string[] {
  const routes: string[] = [];
  const lines = contract.split('\n');
  let currentPath: string | null = null;

  for (const line of lines) {
    const pathMatch = /^  (\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1].startsWith('/api/v1/') ? pathMatch[1] : null;
      continue;
    }

    const methodMatch = /^    (get|post|put|patch|delete):$/.exec(line);
    if (currentPath && methodMatch) {
      routes.push(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }

  return routes;
}
