import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modal = readFileSync(new URL('./AddToOrderModal.tsx', import.meta.url), 'utf8');
const panelsTab = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const viewPage = readFileSync(new URL('./BazisProjectViewPage.tsx', import.meta.url), 'utf8');

describe('add-to-order modal source guards', () => {
  it('loads orders with server filtering by client and search', () => {
    expect(modal).toMatch(/ordersApi\.list\(\{\s*clientId: projectClientId,\s*search:/);
    // Клиент берётся из initial order-draft (карточка проекта клиента не отдаёт)
    expect(modal).toContain('bazisApi.orderDraft(revisionId, { selectedNodeIds })');
    expect(modal).toContain('disabled={projectClient == null}');
    expect(modal).toContain("sortBy: 'orderDate'");
    expect(modal).toContain('filterOption={false}');
  });

  it('requests draft preview for the picked target order and exposes replace/skip radios', () => {
    expect(modal).toContain('bazisApi.orderDraft(revisionId, { selectedNodeIds, targetOrderId })');
    expect(modal).toContain('Заменить');
    expect(modal).toContain('Пропустить');
  });

  it('forces ambiguous matches into skips and refreshes draft after 409 conflict', () => {
    expect(modal).toContain('ambiguousDuplicates.map(({ bazisNodeId, orderDetailId }) => ({ bazisNodeId, orderDetailId }))');
    expect(modal).toContain("error.code === 'BAZIS_ADD_TO_ORDER_CONFLICT'");
    expect(modal).toContain('await loadDraft(selectedOrderId);');
  });

  it('regenerates idempotency key on open and on failed requests', () => {
    expect(modal).toContain('setIdempotencyKey(createUuid());');
    expect(modal).toContain("error.code === 'BAZIS_IDEMPOTENCY_FAILED' || error.code === 'BAZIS_IDEMPOTENCY_REUSED'");
    expect(modal).toContain("error.code === 'BAZIS_UNMAPPED_MATERIALS'");
  });

  it('opens from PanelsTab and receives client props from the project page', () => {
    expect(panelsTab).toContain('setAddToOrderOpen(true)');
    expect(panelsTab).toContain('<AddToOrderModal');
    expect(panelsTab).not.toContain('clientId={clientId}');
  });
});
