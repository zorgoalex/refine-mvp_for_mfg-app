import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pdfImport = readFileSync(new URL('../orders/components/import/PdfImportModal.tsx', import.meta.url), 'utf8');
const mapper = readFileSync(new URL('../../api/mappers/orderMapper.ts', import.meta.url), 'utf8');
const panels = readFileSync(new URL('./PanelsTab.tsx', import.meta.url), 'utf8');
const repository = readFileSync(
  new URL('../../../backend/src/modules/bazis/adapters/pg-bazis-repository.ts', import.meta.url),
  'utf8',
);

describe('Bazis imported panel order links', () => {
  it('carries PDF-import intent as sidecar client keys, not a persisted detail field', () => {
    expect(pdfImport).toContain('addPdfImportedDetail');
    expect(mapper).toContain('bazisImportCandidateClientKeys');
    expect(mapper).toContain('pdfImportCandidateTempIds');
    expect(mapper).not.toContain('bazisImportCandidate: detail.');
  });

  it('shows imported order-only links but keeps ignored/null rows hidden', () => {
    expect(repository).toMatch(/m\.mapping_kind\s*=\s*'imported'/);
    expect(repository).toMatch(/m\.order_detail_id\s+IS\s+NOT\s+NULL/);
    expect(repository).toMatch(/m\.mapping_kind\s*<>\s*'ignored'/);
  });

  it('refreshes panel orders after existing order-data change event', () => {
    expect(panels).toContain('subscribeOrderDataChanged');
    expect(panels).toContain('refreshPanelOrders');
  });

  it('keeps order value clickable', () => {
    expect(panels).toContain('to={`/orders/show/${order.orderId}`}');
    expect(panels).toContain("order.orderName?.trim() || `#${order.orderId}`");
  });
});
