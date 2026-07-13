import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bazisDraftHelpers = readFileSync(new URL('./bazisOrderDraft.ts', import.meta.url), 'utf8');
const orderFormStore = readFileSync(new URL('../../stores/orderFormStore.ts', import.meta.url), 'utf8');
const orderTypes = readFileSync(new URL('../../types/orders.ts', import.meta.url), 'utf8');
const orderForm = readFileSync(new URL('../orders/components/OrderForm.tsx', import.meta.url), 'utf8');
const useOrderSave = readFileSync(new URL('../../hooks/useOrderSave.ts', import.meta.url), 'utf8');

describe('bazis draft order guards', () => {
  it('stores provenance in a dedicated bazisNodeId field and clears it on copied rows', () => {
    expect(orderTypes).toContain('bazisNodeId?: number | null;');
    expect(orderFormStore).toMatch(/insertDetailAfter[\s\S]*?bazisNodeId: undefined/);
  });

  it('collects provenance nodes separately from client keys', () => {
    expect(bazisDraftHelpers).toContain('collectProvenanceNodes');
    expect(bazisDraftHelpers).toContain('console.warn');
    expect(bazisDraftHelpers).toContain('bazisNodeId');
  });

  it('draft save goes through bazisApi.createOrderFromDraft with collected nodes', () => {
    expect(useOrderSave).toContain('bazisApi.createOrderFromDraft');
    expect(useOrderSave).toContain('collectNodes(values)');
    expect(useOrderSave).toContain('regenerateIdempotencyKey');
  });

  it('legacy save path fail-closes when a bazis draft context is present', () => {
    // Провенанс пишется только backend-командой: legacy Hasura-путь обязан
    // отказать, а не молча создать заказ без node-map/links.
    expect(useOrderSave).toMatch(
      /Legacy rollback path[\s\S]*?if \(bazisDraftSaveContext\) \{[\s\S]*?throw new Error/,
    );
  });

  it('order create form seeds from bazisDraft and locks the client field', () => {
    expect(orderForm).toContain('draftToFormSeed(bazisDraft)');
    expect(orderForm).toContain('Клиент Базис-проекта');
    expect(orderForm).toContain('readBazisDraftFromLocationState');
  });
});
