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
    expect(route).toContain('CSV-список ID заказов');
    expect(route).toContain('только для production');
    expect(route).toContain("$ref: '#/components/schemas/OrderStatusBoardResponse'");
    expect(route).toContain("'422':");
    expect(route).toContain("'503':");
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
