import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = existsSync(resolve(process.cwd(), 'backend/contracts'))
  ? resolve(process.cwd(), 'backend')
  : process.cwd();
const contract = readFileSync(
  resolve(backendRoot, 'contracts/04-api-contract.openapi.yaml'),
  'utf8',
);

describe('order status board OpenAPI contract', () => {
  it('documents the board route, bounded query and typed response', () => {
    const route = sectionBetween(
      contract,
      '  /api/v1/orders/status-board:',
      '  /api/v1/orders/form-data:',
    );

    expect(route).toContain('operationId: getOrderStatusBoard');
    expect(route).toContain('enum: [order, production]');
    expect(route).toContain("pattern: '^(unassigned|[1-9][0-9]*)$'");
    expect(route).toContain('maximum: 60');
    expect(route).toContain('- name: includeDone');
    expect(route).toContain('- name: orderIds');
    expect(route).toContain('- name: sortBy');
    expect(route).toContain('enum: [priority, orderNumber, plannedDate, updatedAt]');
    expect(route).toContain('- name: sortOrder');
    expect(route).toContain('enum: [asc, desc]');
    expect(route).toContain('CSV-список ID заказов');
    expect(route).toContain('только для production');
    expect(route).toContain("$ref: '#/components/schemas/OrderStatusBoardResponse'");
    expect(route).toContain("'422':");
    expect(route).toContain("'503':");
  });

  it('documents MDF manual moves as shared production-task state', () => {
    const listRoute = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-manual-moves:',
      '  /api/v1/orders/status-board/mdf-manual-moves/{cardKind}/{cardId}:',
    );
    expect(listRoute).toContain('operationId: listMdfBoardManualMoves');
    expect(listRoute).toContain('x-permission: production.tasks.view');
    expect(listRoute).toContain("$ref: '#/components/schemas/MdfBoardManualMovesResponse'");
    expect(listRoute).toContain('Клиенты не хранят это состояние локально');

    const writeRoute = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-manual-moves/{cardKind}/{cardId}:',
      '  /api/v1/orders/resource-demands:',
    );
    expect(writeRoute).toContain('operationId: upsertMdfBoardManualMove');
    expect(writeRoute).toContain('operationId: deleteMdfBoardManualMove');
    expect(writeRoute).toContain('x-permission: production.tasks.update');
    expect(writeRoute).toContain('enum: [packet, bazisCutSet, bath, order]');
    expect(writeRoute).toContain("pattern: '^[A-Za-z0-9._:-]+$'");
    expect(writeRoute.match(/parameters\/MdfSourceToken/g)).toHaveLength(2);
    expect(writeRoute.match(/parameters\/MdfCommandIdempotencyKey/g)).toHaveLength(2);
    expect(writeRoute.match(/'409':/g)).toHaveLength(2);
    expect(writeRoute).toContain('jobId не означает завершение пересчёта');

    const schemas = sectionBetween(
      contract,
      '    MdfBoardManualMoveTargetColumn:',
      '    OrderStatusBoardResponse:',
    );
    expect(schemas).toContain('    MdfBoardManualMovesResponse:');
    expect(schemas).toContain('    MdfBoardManualMoveUpsertResponse:');
    expect(schemas).toContain('    MdfBoardManualMoveDeleteResponse:');
    expect(schemas).toContain('- completed_baths');
    expect(schemas).toContain('- orders_issued');
    expect(schemas.match(/        jobId:/g)).toHaveLength(2);
    const publication = sectionBetween(contract, '    MdfPublishedSnapshot:', '    StageSettings:');
    expect(publication).toContain('              commandToken:');
    expect(publication).toContain("pattern: '^[a-f0-9]{64}$'");
  });

  it('documents active evidence correction as a separate token-bound preview/confirm protocol', () => {
    const preview = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-corrections/{cardKind}/{cardId}/preview:',
      '  /api/v1/orders/status-board/mdf-corrections/{cardKind}/{cardId}/confirm:',
    );
    const confirm = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-corrections/{cardKind}/{cardId}/confirm:',
      '  /api/v1/orders/status-board/mdf-manual-moves:',
    );
    expect(preview).toContain('operationId: previewMdfActiveProductionReturn');
    expect(preview).toContain('MdfActiveProductionReturnPreviewRequest');
    expect(preview).toContain("'409':");
    expect(confirm).toContain('operationId: confirmMdfActiveProductionReturn');
    expect(confirm).toContain('MdfActiveProductionReturnConfirmRequest');
    expect(confirm).toContain('Тот же actor/key');
    expect(confirm).toContain('MdfActiveProductionReturnConfirmResponse');

    const schemas = sectionBetween(contract, '    MdfActiveProductionReturnPreviewRequest:', '    MdfCorrectionSource:');
    expect(schemas).toContain('additionalProperties: false');
    expect(schemas).toContain('required: [sourceToken, targetColumn, expectedDigest, idempotencyKey]');
    expect(schemas).toContain("pattern: '^[A-Za-z0-9._:-]{1,128}$'");
    expect(schemas).toContain('deferredPriorAutomation:');
    expect(schemas).toContain('cncFreshnessBaseline:');
    expect(schemas).toContain('manualPlacementColumnBefore');
    expect(schemas).toContain('manualPlacementColumnAfter');
    expect(schemas).toContain('clearsManualPlacementOverride');
    // §5.5: authoritative resulting columns, card quantity and order status consequences are part of the preview.
    expect(schemas).toContain('afterColumn:');
    expect(schemas).toContain('afterIssues:');
    expect(schemas).toContain('cardQuantity:');
    expect(schemas).toContain('statusKept:');
    expect(schemas).toContain('sourceAfter:');
    expect(schemas).toContain('afterStatusId:');
    expect(contract).toContain('  /api/v1/orders/status-board/mdf-engine:');
    expect(contract).toContain('operationId: getMdfEngineMode');
    expect(schemas).not.toContain('replayed:');
    expect(contract).toContain('  /api/v1/orders/status-board/mdf-return/{cardKind}/{cardId}/preview:');
  });

  it('documents the displayFrom window param on the published MDF board route', () => {
    const route = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf:',
      '  /api/v1/orders/status-board/mdf-return/{cardKind}/{cardId}/preview:',
    );
    expect(route).toContain('operationId: getPublishedMdfBoard');
    expect(route).toContain('- { name: displayFrom, in: query');
    expect(route).toContain('dateTo минус 6 дней');
  });

  it('documents the demand-drift conflicts list/confirm routes (§5.8 reconciler)', () => {
    const listRoute = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-drift:',
      '  /api/v1/orders/status-board/mdf-drift/{conflictId}/confirm:',
    );
    expect(listRoute).toContain('operationId: listMdfDemandDriftConflicts');
    expect(listRoute).toContain('x-permission: orders.view');
    expect(listRoute).toContain("$ref: '#/components/schemas/MdfDemandDriftConflict'");
    expect(listRoute).toContain("'403':");

    const confirmRoute = sectionBetween(
      contract,
      '  /api/v1/orders/status-board/mdf-drift/{conflictId}/confirm:',
      '  /api/v1/orders/{orderId}/resource-procurement/{resourceKey}:',
    );
    expect(confirmRoute).toContain('operationId: confirmMdfDemandDrift');
    expect(confirmRoute).toContain('x-permission: orders.update');
    expect(confirmRoute).toContain("format: uuid");
    expect(confirmRoute).toContain("pattern: '^[a-f0-9]{64}$'");
    expect(confirmRoute).toContain('resolved:');
    expect(confirmRoute).toContain("'404':");
    expect(confirmRoute).toContain("'409':");

    const schema = sectionBetween(
      contract,
      '    MdfDemandDriftConflict:',
      '    OrderStatusBoardResponse:',
    );
    expect(schema).toContain('conflictId');
    expect(schema).toContain('CONFIRMATION_REQUIRED, HARD_CONFLICT, BLOCKED_BY_CLOSURE, MDF_RECONCILE_SCOPE_LIMIT');
    expect(schema).toContain('orderIds');
    expect(schema).toContain('detectedAt');
  });

  it('keeps pagination, capabilities and nullable financials explicit', () => {
    const response = sectionBetween(
      contract,
      '    OrderStatusBoardResponse:',
      '    OrderListResponse:',
    );

    expect(response).toContain('    OrderStatusBoardColumn:');
    expect(response).toContain('    OrderStatusBoardCard:');
    expect(response).toContain('- nextCursor');
    expect(response).toContain('- canChangeOrderStatus');
    expect(response).toContain('- canChangeProductionStatus');
    expect(response).toContain('- financialsVisible');
    expect(response).toContain('- orderStatusIssuedOrLater');
    expect(response).toContain('- details');
    expect(response).toContain('    OrderStatusBoardCardDetail:');
    expect(response).toContain('- bazisCutQuantity');
    expect(response).toContain('        orderStatusIssuedOrLater:\n          type: boolean');

    for (const field of ['finalAmount', 'paidAmount', 'debtAmount']) {
      const block = sectionBetween(
        response,
        `        ${field}:`,
        field === 'finalAmount'
          ? '        paidAmount:'
          : field === 'paidAmount'
            ? '        debtAmount:'
            : '        partsCount:',
      );
      expect(block).toContain('nullable: true');
    }
  });
});

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
