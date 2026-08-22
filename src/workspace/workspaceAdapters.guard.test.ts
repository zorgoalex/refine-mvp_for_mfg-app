import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(resolve(__dirname, relativePath), 'utf8');

describe('mandatory order workspace adapter coverage', () => {
  it('covers inline editors, detail/payment/bulk forms and cut/transfer surfaces', () => {
    const detailsTab = read('../pages/orders/components/tabs/OrderDetailsTab.tsx');
    const paymentsTab = read('../pages/orders/components/tabs/OrderPaymentsTab.tsx');
    expect(read('../pages/orders/components/tables/OrderDetailTable.tsx'))
      .toContain("'detail-inline-editor'");
    expect(read('../pages/orders/components/tables/OrderPaymentTable.tsx'))
      .toContain("'payment-inline-editor'");
    expect(read('../pages/orders/components/modals/OrderDetailModal.tsx'))
      .toContain("'detail-modal'");
    expect(read('../pages/orders/components/modals/PaymentModal.tsx'))
      .toContain("'payment-modal'");
    expect(read('../pages/orders/components/modals/BulkEditModal.tsx'))
      .toContain("'bulk-edit-modal'");
    expect(read('../pages/orders/components/AddToCutModal.tsx'))
      .toContain("'add-to-cut-modal'");
    expect(read('../pages/orders/components/OrderDetailTransferModal.tsx'))
      .toContain("'detail-transfer-modal'");
    expect(detailsTab).toContain('dragSelectionState === null && !restoredEditPending');
    expect(paymentsTab).toContain('canCapture: () => !restoredEditPending');
  });

  it('covers Excel/PDF/VLM wizard state and keeps browser files out of UI checkpoints', () => {
    const excel = read('../pages/orders/components/import/ExcelImportModal.tsx');
    const pdf = read('../pages/orders/components/import/PdfImportModal.tsx');
    const vlm = read('../pages/orders/components/import/VlmImportModal.tsx');
    expect(excel).toContain("'excel-import-wizard'");
    expect(excel).toContain("attachmentKey: 'excel-file'");
    expect(excel).toContain("attachmentKey: 'excel-workbook'");
    expect(pdf).toContain("'pdf-import-wizard'");
    expect(pdf).toContain("attachmentKey: 'pdf-file'");
    expect(vlm).toContain("'vlm-import-wizard'");
    expect(read('../pages/orders/components/import/steps/PhotoUploadStep.tsx'))
      .toContain("attachmentKey: 'vlm-photo-file'");
    const photo = read('../pages/orders/components/import/steps/PhotoUploadStep.tsx');
    expect(photo).toContain('const retained = retainWorkspaceAttachment({');
    expect(photo).toContain('if (!retained)');
    expect(photo.indexOf('if (!retained)')).toBeLessThan(photo.indexOf('URL.createObjectURL(fileObj)'));
    expect([excel, pdf, vlm].join('\n')).not.toContain('localStorage');
  });
});
