import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('orders OpenAPI contract', () => {
  it('documents stale-safe idempotent DELETE /api/v1/orders/{orderId}', () => {
    const contract = readOpenApiContract();
    const deleteSection = sectionBetween(
      contract,
      '    delete:\n      tags:\n        - Orders\n      operationId: deleteOrder',
      '  /api/v1/orders/{orderId}/status:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    DeleteOrderResponse:',
      '    ExportOrderRequest:',
    );

    expect(deleteSection).toContain("$ref: '#/components/parameters/IdempotencyKey'");
    expect(deleteSection).toContain("$ref: '#/components/parameters/IfMatchVersion'");
    expect(deleteSection).toContain("'400':");
    expect(deleteSection).toContain("'409':");
    expect(deleteSection).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(deleteSection).toContain('IDEMPOTENCY_IN_PROGRESS');
    expect(deleteSection).toContain('IDEMPOTENCY_FAILED');
    expect(responseSchema).toContain('- success');
    expect(responseSchema).toContain('- orderId');
    expect(responseSchema).toContain('- requestId');
    expect(responseSchema).toContain('auditId:');
  });

  it('documents GET /api/v1/orders/{orderId}/audit under v1 orders API', () => {
    const contract = readOpenApiContract();
    const auditSection = sectionBetween(
      contract,
      '  /api/v1/orders/{orderId}/audit:',
      '  /api/v1/users:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    AuditListResponse:',
      '    AuditEventDto:',
    );

    expect(auditSection).toContain('operationId: getOrderAudit');
    expect(auditSection).toContain('x-permission: orders.view_audit');
    expect(auditSection).toContain("$ref: '#/components/parameters/Page'");
    expect(auditSection).toContain("$ref: '#/components/parameters/PageSize'");
    expect(auditSection).toContain("'404':");
    expect(responseSchema).toContain('- requestId');
    expect(responseSchema).toContain('requestId:');
  });
});

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), '../spec_back-erp/prd_v1/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), '../../spec_back-erp/prd_v1/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}
