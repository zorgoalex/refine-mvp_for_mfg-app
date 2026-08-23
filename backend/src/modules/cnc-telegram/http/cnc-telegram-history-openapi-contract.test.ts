import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(
  new URL('../../../../contracts/04-api-contract.openapi.yaml', import.meta.url),
  'utf8',
);

describe('CNC Telegram MDF history OpenAPI contract', () => {
  it('documents independent order search and causal history under orders.view', () => {
    const routes = contract.slice(
      contract.indexOf('/api/v1/cnc-telegram/mdf-board/history/orders:'),
      contract.indexOf('/api/v1/cnc-telegram/manual-svg-upload:'),
    );

    expect(routes).toContain('operationId: searchMdfBoardHistoryOrders');
    expect(routes).toContain('operationId: getMdfBoardHistory');
    expect(routes.match(/x-permission: orders\.view/g)).toHaveLength(2);
    expect(routes).toContain("$ref: '#/components/schemas/MdfBoardHistoryResponse'");
    expect(contract).toContain('MdfBoardHistoryEvent:');
    expect(contract).toContain('provenance: { type: string, enum: [recorded, reconstructed, net_reconstructed] }');
  });
});
