import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bazisDraftHelpers = readFileSync(new URL('./bazisOrderDraft.ts', import.meta.url), 'utf8');
const orderFormStore = readFileSync(new URL('../../stores/orderFormStore.ts', import.meta.url), 'utf8');
const orderTypes = readFileSync(new URL('../../types/orders.ts', import.meta.url), 'utf8');
const orderForm = readFileSync(new URL('../orders/components/OrderForm.tsx', import.meta.url), 'utf8');
const useOrderSave = readFileSync(new URL('../../hooks/useOrderSave.ts', import.meta.url), 'utf8');
const orderBasicInfo = readFileSync(
  new URL('../orders/components/sections/OrderBasicInfo.tsx', import.meta.url),
  'utf8',
);

const appRoutes = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('bazis draft order guards', () => {
  it('/orders/create зароучен — draft-first навигация не падает в пустой экран', () => {
    expect(appRoutes).toContain('<Route path="create" element={<OrderCreate />} />');
    expect(appRoutes).toContain('pages/orders/create');
  });

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

  it('draft save gates unpriced details (parity with the detail modal cost rule)', () => {
    expect(useOrderSave).toContain('Не заполнены цены деталей');
    expect(useOrderSave).toMatch(/milling_cost_per_sqm == null \|\| detail\.milling_cost_per_sqm === 0/);
  });

  it('legacy save path fail-closes when a bazis draft context is present', () => {
    // Провенанс пишется только backend-командой: legacy Hasura-путь обязан
    // отказать, а не молча создать заказ без node-map/links.
    expect(useOrderSave).toMatch(
      /Legacy rollback path[\s\S]*?if \(bazisDraftSaveContext\) \{[\s\S]*?throw new Error/,
    );
  });

  it('order create form seeds from bazisDraft and locks the client field for real', () => {
    expect(orderForm).toContain('draftToFormSeed(bazisDraft)');
    expect(orderForm).toContain('readBazisDraftFromLocationState');
    expect(orderForm).toContain('<OrderBasicInfo clientLocked={bazisDraftClientLocked} />');
    // Проп идёт из memoized tab-tree — deps обязаны включать lock-флаг (Critic code-R2)
    expect(orderForm).toMatch(/\[mode, header\.order_id, orderId, labelsEnabled, isDirty, cutTabEnabled, bazisDraftClientLocked\]/);
    // Настоящий disabled + скрытое создание клиента, не DOM-косметика
    expect(orderBasicInfo).toContain('disabled={clientLocked}');
    expect(orderBasicInfo).toMatch(/if \(clientLocked\) \{\s*return;\s*\}/);
    expect(orderBasicInfo).toContain("extra={clientLocked ? 'Клиент Базис-проекта' : undefined}");
    expect(orderBasicInfo).toContain('{!clientLocked ? (');
  });

  it('locks the ERP project to the Bazis project while creating the order', () => {
    expect(orderForm).toContain("const bazisDraftProjectLocked = mode === 'create' && bazisDraft != null;");
    expect(orderForm).toContain('disabled={!normalizedClientId || bazisDraftProjectLocked}');
    expect(orderForm).toContain("extra={bazisDraftProjectLocked ? 'Проект Базис-проекта' : undefined}");
  });
});
