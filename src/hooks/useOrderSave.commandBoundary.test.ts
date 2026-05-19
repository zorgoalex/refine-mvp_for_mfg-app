import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const USE_ORDER_SAVE_PATH = join(process.cwd(), 'src/hooks/useOrderSave.ts');

describe('useOrderSave command boundary', () => {
  it('routes backend-enabled order saves before legacy workflow child mutations', () => {
    const source = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    const backendFlagIndex = source.indexOf('featureFlags.useBackendOrdersWrite');
    const backendSaveIndex = source.indexOf('saveOrderViaBackend', backendFlagIndex);
    const backendReturnIndex = source.indexOf('return savedOrderId', backendSaveIndex);
    const legacyWorkflowMutationIndexes = [
      "resource: 'order_workshops'",
      "resource: 'order_resource_requirements'",
      "resource: 'order_doweling_links'",
      "resource: 'doweling_orders'",
    ].map((resource) => source.indexOf(resource));

    expect(backendFlagIndex).toBeGreaterThanOrEqual(0);
    expect(backendSaveIndex).toBeGreaterThan(backendFlagIndex);
    expect(backendReturnIndex).toBeGreaterThan(backendSaveIndex);
    expect(legacyWorkflowMutationIndexes.every((index) => index > backendReturnIndex)).toBe(true);
  });

  it('does not force nested payment mutations around backend payment routing', () => {
    const source = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');

    expect(source).not.toContain('LEGACY_ORDER_SAVE_PAYMENT_META');
    expect(source).not.toContain('forceHasuraMutation');
  });

  it('does not attach meta to payments create/update/delete calls', () => {
    const source = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    const paymentMutationBlocks = Array.from(
      source.matchAll(/dataProvider\(\)\.(create|update|deleteOne)\(\{\s*resource:\s*['"]payments['"][\s\S]*?\n\s*\}\)/g),
      (match) => ({ operation: match[1], block: match[0] }),
    );

    expect(paymentMutationBlocks.map(({ operation }) => operation).sort()).toEqual([
      'create',
      'deleteOne',
      'update',
    ]);
    expect(paymentMutationBlocks.map(({ block }) => block)).toEqual(
      expect.not.arrayContaining([expect.stringContaining('meta:')]),
    );
  });
});
