import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const summarySource = readFileSync(
  'src/pages/orders/components/sections/OrderHeaderSummary.tsx',
  'utf8',
);
const menuSource = readFileSync(
  'src/pages/orders/components/OrderHeaderContextMenu.tsx',
  'utf8',
);

describe('order header production status synchronization', () => {
  it('derives summary letters only from active events and the active menu catalog', () => {
    expect(summarySource).toContain('resolveActiveProductionEventCodes(\n      productionStatusEvents.events');
    expect(summarySource).toContain('buildActiveProductionStatusCodeMap');
    expect(summarySource).not.toContain('productionEventsData');
    expect(summarySource).not.toContain('resolveCurrentProductionStatusCodes');
  });

  it('shares one optimistic event controller with every context-menu rendering', () => {
    expect(summarySource.match(/productionStatusEvents=\{productionStatusEvents\}/g)).toHaveLength(3);
    expect(menuSource).toContain('const { toggleOrderEvent, events, refetch } = productionStatusEvents;');
    expect(menuSource).not.toContain('useProductionStatusEvent({');
  });

  it('keeps event reads enabled for packers while hiding their mutation menus', () => {
    expect(summarySource).toContain('useProductionStatusEvent({\n    orderId: header.order_id,\n  })');
    expect(menuSource).toContain('...(!packerMode');
    expect(menuSource).toContain("key: 'production_status'");
  });
});
