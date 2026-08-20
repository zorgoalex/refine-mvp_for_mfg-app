import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OrderHdfTab bulk parameter save', () => {
  it('saves the order through the shared form flow and relies on backend HDF reconciliation', () => {
    const tab = readFileSync(new URL('./OrderHdfTab.tsx', import.meta.url), 'utf8');
    const form = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
    const service = readFileSync(
      new URL('../../../../../backend/src/modules/orders/application/order-transaction.service.ts', import.meta.url),
      'utf8',
    );

    expect(tab).toContain('onSave: () => Promise<boolean>');
    expect(tab).toContain('const saved = await onSave()');
    expect(tab).toContain('ХДФ пересчитан.');
    expect(tab).toContain('Сохранить');
    expect(tab).not.toContain('>\n                Применить\n              </Button>');
    expect(form).toContain('<OrderHdfTab onSave={handleSave} isSaving={isSaving} />');
    expect(service).toContain('await unitOfWork.reconcileHdfDetails({ orderId, currentUser, requestId })');
  });
});
