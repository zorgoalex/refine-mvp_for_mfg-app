import { describe, expect, it } from 'vitest';
import { orderDetailHdfCellText } from './OrderDetailTable';

const display = (over: Record<string, unknown>) => ({ status: 'ok', isStale: false, heightMm: 716, widthMm: 396.5, ...over }) as never;

describe('text of the HDF cell (what the customer screen mirrors)', () => {
  it('a calculated HDF detail shows its size', () => {
    expect(orderDetailHdfCellText(display({}), 3)).toBe('716×396,5');
  });

  it('a stale or failed calculation shows its state, not the parameter', () => {
    expect(orderDetailHdfCellText(display({ isStale: true }), 3)).toBe('устар.');
    expect(orderDetailHdfCellText(display({ status: 'too_narrow', heightMm: null, widthMm: null }), 3)).toBe('Узкая деталь');
    expect(orderDetailHdfCellText(display({ status: 'config_missing' }), null)).toBe('нет настр.');
  });

  it('no calculation: the bare parameter in millimetres, or nothing', () => {
    expect(orderDetailHdfCellText(null, 3)).toBe('3 мм');
    expect(orderDetailHdfCellText(null, 3.25)).toBe('3,25 мм');
    expect(orderDetailHdfCellText(null, null)).toBeNull();
    expect(orderDetailHdfCellText(null, '')).toBeNull();
  });
});
