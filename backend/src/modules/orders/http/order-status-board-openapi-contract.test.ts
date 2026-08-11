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

    const schemas = sectionBetween(
      contract,
      '    MdfBoardManualMoveTargetColumn:',
      '    OrderStatusBoardResponse:',
    );
    expect(schemas).toContain('    MdfBoardManualMovesResponse:');
    expect(schemas).toContain('    MdfBoardManualMoveUpsertResponse:');
    expect(schemas).toContain('    MdfBoardManualMoveDeleteResponse:');
    expect(schemas).toContain('- orders_issued');
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
