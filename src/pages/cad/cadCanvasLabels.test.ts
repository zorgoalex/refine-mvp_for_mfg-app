import { expect, it } from 'vitest';
import type { CadSourceSnapshot } from '@shared/cad-workspace';
import { cadInstanceLabel } from './cadCanvasGeometry';

const source: CadSourceSnapshot = { id: 'snapshot', orderId: 11579, orderName: '2833', capturedAt: '', parts: [] };
it('labels instances with the displayed order number, never the database ID', () => {
  expect(cadInstanceLabel(source, 2, '3/10')).toBe('№2833 / 2 · 3/10');
  expect(cadInstanceLabel({ ...source, id: 'imported', orderId: 99, orderName: 'Тест-0007' }, 4, '1/2')).toBe('№Тест-0007 / 4 · 1/2');
});
it('does not fall back to an internal ID if the snapshot has no displayed number', () => {
  expect(cadInstanceLabel({ ...source, orderName: ' ' }, 2, '×1')).toBe('№— / 2 · ×1');
  expect(cadInstanceLabel(undefined, 2, '×1')).toBe('№— / 2 · ×1');
});
