import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  saveOrderDetailSwaggerSchema,
  orderDetailResponseSwaggerSchema,
  saveOrderHeaderSwaggerSchema,
  orderHeaderResponseSwaggerSchema,
} from './orders.controller';

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
    expect(auditSection).toContain('x-permissions:');
    expect(auditSection).toContain('- orders.view_audit');
    expect(auditSection).toContain('- orders.view_financials');
    expect(auditSection).toContain("$ref: '#/components/parameters/Page'");
    expect(auditSection).toContain("$ref: '#/components/parameters/PageSize'");
    expect(auditSection).toContain("'404':");
    expect(responseSchema).toContain('- requestId');
    expect(responseSchema).toContain('requestId:');
  });

  it('documents order production action endpoints and legacy status alias', () => {
    const contract = readOpenApiContract();

    expect(contract).toContain('  /api/v1/orders/{orderId}/calendar-date:');
    expect(contract).toContain('operationId: moveOrderCalendarDate');
    expect(contract).toContain('  /api/v1/orders/{orderId}/status:');
    expect(contract).toContain('operationId: changeOrderStatus');
    expect(contract).toContain('  /api/v1/orders/{orderId}/production-status:');
    expect(contract).toContain('  /api/v1/orders/{orderId}/order-status:');
    expect(contract).toContain('operationId: changeOrderStatusLegacy');
    expect(contract).toContain('  /api/v1/orders/{orderId}/production-stage-events/{productionStatusId}:');
    expect(contract).toContain('operationId: activateProductionStage');
    expect(contract).toContain('operationId: deactivateProductionStage');
  });

  it('documents current order project links without legacy PATCH singular project route', () => {
    const contract = readOpenApiContract();
    const controllerSource = readFileSync(
      resolve(process.cwd(), 'backend/src/modules/orders/http/order-group-links.controller.ts'),
      'utf8',
    );
    const repositorySource = readFileSync(
      resolve(process.cwd(), 'backend/src/modules/orders/adapters/pg-order-group-link-repository.ts'),
      'utf8',
    );

    expect(controllerSource).toContain("@Controller('orders/:orderId/groups')");
    expect(controllerSource).toContain('operationId: \'getOrderProjects\'');
    expect(controllerSource).toContain('operationId: \'replaceOrderProjects\'');
    expect(repositorySource).toContain("'groups.order_links.replace'");
    expect(repositorySource).not.toContain("'projects.order_links.replace'");
    expect(contract).toContain('    ReplaceOrderProjectsRequest:');
    expect(contract).toContain('    OrderProjectSummaryDto:');
    expect(contract).not.toContain('/api/v1/orders/{orderId}/project:');
  });

  it('documents order snapshot export and import endpoints without raw content schemas', () => {
    const contract = readOpenApiContract();

    expect(contract).toContain('  /api/v1/orders/{orderId}/snapshot:');
    expect(contract).toContain('operationId: exportOrderSnapshot');
    expect(contract).toContain('  /api/v1/orders/snapshot/batch:');
    expect(contract).toContain('operationId: exportOrderSnapshotBatch');
    expect(contract).toContain('  /api/v1/orders/snapshot/import:');
    expect(contract).toContain('operationId: importOrderSnapshot');
    expect(contract).toContain('  /api/v1/orders/snapshot/import-batch:');
    expect(contract).toContain('operationId: importOrderSnapshotBatch');
    expect(contract).not.toContain('passwordHash');
    expect(contract).not.toContain('refreshTokenHash');
    expect(contract).not.toContain('providerSecret');
  });

  it('documents Variant B: sheetMaterialTypeId required, materialId nullable/optional on detail schemas', () => {
    const contract = readOpenApiContract();

    // OrderDetailDto (response): sheetMaterialTypeId in required; materialId nullable
    const orderDetailDtoSection = sectionBetween(
      contract,
      '    OrderDetailDto:',
      '    PaymentDto:',
    );
    expect(orderDetailDtoSection).toContain('- sheetMaterialTypeId');
    expect(orderDetailDtoSection).not.toMatch(/^        - materialId$/m);
    // materialId property present but nullable
    expect(orderDetailDtoSection).toContain('materialId:');
    expect(
      sectionBetween(orderDetailDtoSection, '        materialId:', '        sheetMaterialTypeId:'),
    ).toContain('nullable: true');

    // SaveOrderDetailDto (request): sheetMaterialTypeId in required; materialId not in required
    const saveOrderDetailDtoSection = sectionBetween(
      contract,
      '    SaveOrderDetailDto:',
      '    SavePaymentDto:',
    );
    expect(saveOrderDetailDtoSection).toContain('- sheetMaterialTypeId');
    expect(saveOrderDetailDtoSection).not.toMatch(/^        - materialId$/m);
    expect(saveOrderDetailDtoSection).toContain('materialId:');
    expect(
      sectionBetween(saveOrderDetailDtoSection, '        materialId:', '        sheetMaterialTypeId:'),
    ).toContain('nullable: true');
  });

  it('documents Variant B: header materialId and sheetMaterialTypeId present in OrderHeaderDto (response)', () => {
    const contract = readOpenApiContract();

    // OrderHeaderDto (response): materialId and sheetMaterialTypeId must be present and nullable;
    // materialId must NOT be in required (always null in Variant B).
    const orderHeaderDtoSection = sectionBetween(
      contract,
      '    OrderHeaderDto:',
      '    OrderDetailDto:',
    );
    expect(orderHeaderDtoSection).not.toMatch(/^        - materialId$/m);
    expect(orderHeaderDtoSection).toContain('materialId:');
    expect(orderHeaderDtoSection).toContain('sheetMaterialTypeId:');
    // materialId is nullable
    const materialIdBlock = sectionBetween(orderHeaderDtoSection, '        materialId:', '        sheetMaterialTypeId:');
    expect(materialIdBlock).toContain('nullable: true');
    // description must mention Variant B deprecation (not the old Variant A "shadow" text)
    expect(materialIdBlock.toLowerCase()).not.toContain('shadow');
    expect(materialIdBlock.toLowerCase()).toMatch(/deprecated|always null/);
  });

  it('documents Variant B: header materialId and sheetMaterialTypeId present in SaveOrderHeaderDto (request)', () => {
    const contract = readOpenApiContract();

    // SaveOrderHeaderDto (request): materialId and sheetMaterialTypeId must be present;
    // materialId must NOT be in required (must be null/absent — non-null → 422).
    const saveOrderHeaderDtoSection = sectionBetween(
      contract,
      '    SaveOrderHeaderDto:',
      '    SaveOrderDetailDto:',
    );
    expect(saveOrderHeaderDtoSection).not.toMatch(/^        - materialId$/m);
    expect(saveOrderHeaderDtoSection).toContain('materialId:');
    expect(saveOrderHeaderDtoSection).toContain('sheetMaterialTypeId:');
    // materialId is nullable
    const materialIdBlock = sectionBetween(saveOrderHeaderDtoSection, '        materialId:', '        sheetMaterialTypeId:');
    expect(materialIdBlock).toContain('nullable: true');
    // description must mention 422 rejection (not Variant A "shadow" wording)
    expect(materialIdBlock.toLowerCase()).not.toContain('shadow');
    expect(materialIdBlock.toLowerCase()).toMatch(/null|422|deprecated/);
  });
});

// Generated Swagger document tests — asserts the CONTROLLER DECORATOR schemas (not only the
// static YAML). These use the inline schema objects exported from orders.controller.ts,
// which are the exact objects fed to @ApiBody / @ApiResponse. This covers the gap where
// stale decorators can slip through while the static YAML stays correct.
describe('orders controller Swagger schemas — Variant B shape (generated-doc assertions)', () => {
  it('saveOrderDetailSwaggerSchema: sheetMaterialTypeId is in required (Variant B)', () => {
    expect(saveOrderDetailSwaggerSchema.required).toContain('sheetMaterialTypeId');
  });

  it('saveOrderDetailSwaggerSchema: materialId is NOT in required (Variant B nullable/optional)', () => {
    expect(saveOrderDetailSwaggerSchema.required).not.toContain('materialId');
  });

  it('saveOrderDetailSwaggerSchema: materialId property is nullable', () => {
    const materialIdProp = saveOrderDetailSwaggerSchema.properties.materialId as Record<string, unknown>;
    expect(materialIdProp.nullable).toBe(true);
  });

  it('saveOrderDetailSwaggerSchema: materialId description says must be null/absent (Variant B)', () => {
    const materialIdProp = saveOrderDetailSwaggerSchema.properties.materialId as Record<string, unknown>;
    expect(typeof materialIdProp.description).toBe('string');
    const desc = (materialIdProp.description as string).toLowerCase();
    expect(desc).toMatch(/null|absent/);
  });

  it('orderDetailResponseSwaggerSchema: materialId is NOT in required (Variant B: always null)', () => {
    expect(orderDetailResponseSwaggerSchema.required).not.toContain('materialId');
  });

  it('orderDetailResponseSwaggerSchema: sheetMaterialTypeId is in required (Variant B)', () => {
    expect(orderDetailResponseSwaggerSchema.required).toContain('sheetMaterialTypeId');
  });

  it('orderDetailResponseSwaggerSchema: materialId property is nullable', () => {
    const materialIdProp = orderDetailResponseSwaggerSchema.properties.materialId as Record<string, unknown>;
    expect(materialIdProp.nullable).toBe(true);
  });

  it('orderDetailResponseSwaggerSchema: sheetMaterialTypeId property type is integer (non-nullable in Variant B)', () => {
    const smtProp = orderDetailResponseSwaggerSchema.properties.sheetMaterialTypeId as Record<string, unknown>;
    expect(smtProp.type).toBe('integer');
    // sheetMaterialTypeId is required and non-nullable in Variant B response
    expect(smtProp.nullable).toBeUndefined();
  });

  // ── Header schema parity: request + response ─────────────────────────────
  it('saveOrderHeaderSwaggerSchema: materialId present and nullable (Variant B: deprecated)', () => {
    const materialIdProp = saveOrderHeaderSwaggerSchema.properties.materialId as Record<string, unknown>;
    expect(materialIdProp).toBeDefined();
    expect(materialIdProp.nullable).toBe(true);
  });

  it('saveOrderHeaderSwaggerSchema: materialId is NOT in required (must be null/absent on request)', () => {
    expect(saveOrderHeaderSwaggerSchema.required).not.toContain('materialId');
  });

  it('saveOrderHeaderSwaggerSchema: materialId description does NOT contain Variant A "shadow" text', () => {
    const materialIdProp = saveOrderHeaderSwaggerSchema.properties.materialId as Record<string, unknown>;
    const desc = (materialIdProp.description as string | undefined)?.toLowerCase() ?? '';
    expect(desc).not.toContain('shadow');
    expect(desc).toMatch(/deprecated|null/);
  });

  it('saveOrderHeaderSwaggerSchema: sheetMaterialTypeId present and nullable (optional on header)', () => {
    const smtProp = saveOrderHeaderSwaggerSchema.properties.sheetMaterialTypeId as Record<string, unknown>;
    expect(smtProp).toBeDefined();
    expect(smtProp.nullable).toBe(true);
  });

  it('saveOrderHeaderSwaggerSchema: sheetMaterialTypeId description does NOT contain Variant A "shadow" text', () => {
    const smtProp = saveOrderHeaderSwaggerSchema.properties.sheetMaterialTypeId as Record<string, unknown>;
    const desc = (smtProp.description as string | undefined)?.toLowerCase() ?? '';
    expect(desc).not.toContain('shadow');
  });

  it('orderHeaderResponseSwaggerSchema: materialId present and nullable (always null in Variant B)', () => {
    const materialIdProp = orderHeaderResponseSwaggerSchema.properties.materialId as Record<string, unknown>;
    expect(materialIdProp).toBeDefined();
    expect(materialIdProp.nullable).toBe(true);
  });

  it('orderHeaderResponseSwaggerSchema: materialId is NOT in required (always null in Variant B response)', () => {
    expect(orderHeaderResponseSwaggerSchema.required).not.toContain('materialId');
  });

  it('orderHeaderResponseSwaggerSchema: sheetMaterialTypeId present (optional, nullable on header response)', () => {
    const smtProp = orderHeaderResponseSwaggerSchema.properties.sheetMaterialTypeId as Record<string, unknown>;
    expect(smtProp).toBeDefined();
    expect(smtProp.nullable).toBe(true);
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
