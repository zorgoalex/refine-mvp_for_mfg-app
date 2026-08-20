import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(
  new URL('../../../../contracts/04-api-contract.openapi.yaml', import.meta.url),
  'utf8',
);

describe('CNC Telegram original-board OpenAPI contract', () => {
  it('documents the read-only orders.view route and exact current-location fields', () => {
    const route = contract.slice(
      contract.indexOf('/api/v1/cnc-telegram/mdf-board/original:'),
      contract.indexOf('/api/v1/cnc-telegram/media/{storageKey}:'),
    );

    expect(route).toContain('operationId: listCncTelegramOriginalBoard');
    expect(route).toContain('x-permission: orders.view');
    expect(route).not.toContain('in: query');
    expect(route).toContain("$ref: '#/components/schemas/CncTelegramOriginalBoardResponse'");
    expect(contract).toContain('CncTelegramOriginalPacket:');
    expect(contract).toContain('CncTelegramOriginalBathCard:');
    expect(contract).toContain('CncTelegramOriginalBazisCutSetCard:');
    expect(contract).toContain('currentBoardVisibility:');
    expect(contract).toContain('currentBoardColumn:');
    expect(contract).toContain('currentBoardCardId:');
    expect(contract).toContain('raw storage keys are never returned');
  });
});
