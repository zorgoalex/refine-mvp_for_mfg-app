import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import { counterpartyOptions, isCounterpartyApiMissing, supplierLinkErrorMessage } from './supplierCounterpartyModel';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('supplier ↔ 1C counterparty select', () => {
  it('marks 1C suppliers and blocks a counterparty that belongs to another supplier', () => {
    expect(counterpartyOptions([
      { refKey1c: 'a', name: 'Альфа', isSupplier: true, supplierId: null, supplierName: null },
      { refKey1c: 'b', name: 'Бета', isSupplier: false, supplierId: 7, supplierName: 'Бета-опт' },
      { refKey1c: 'c', name: 'Гамма', isSupplier: null, supplierId: 5, supplierName: 'Гамма' },
    ], 5)).toEqual([
      { value: 'a', label: 'Альфа · поставщик в 1С', disabled: false },
      { value: 'b', label: 'Бета — уже привязан к «Бета-опт»', disabled: true },
      { value: 'c', label: 'Гамма', disabled: false },
    ]);
  });

  it('words link errors and tells an older backend from a missing supplier', () => {
    expect(supplierLinkErrorMessage(new ApiError({ status: 409, code: 'SUPPLIER_COUNTERPARTY_TAKEN', message: 'x' }))).toContain('другому поставщику');
    expect(supplierLinkErrorMessage(new Error('network'))).toBe('Не удалось изменить привязку к контрагенту 1С.');
    expect(isCounterpartyApiMissing(new ApiError({ status: 404, code: 'HTTP_404', message: 'Not Found' }))).toBe(true);
    expect(isCounterpartyApiMissing(new ApiError({ status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'x' }))).toBe(false);
  });
});

describe('supplier forms never write the 1C key or the old phone field', () => {
  // suppliers.ref_key_1c is changed only by the backend command; the phone became the contacts block.
  it('create and edit forms have no ref_key_1c or phone field', () => {
    for (const file of ['./create.tsx', './edit.tsx']) {
      const source = read(file);
      expect(source, file).not.toMatch(/name="ref_key_1c"/);
      expect(source, file).not.toMatch(/name="phone"/);
    }
    expect(read('./edit.tsx')).toContain('<SupplierCounterpartyCard supplierId={supplierId} editable={canManage} />');
  });

  it('the link card sends the key it showed and locks while saving', () => {
    const card = read('./SupplierCounterpartyCard.tsx');
    expect(card).toContain('setSupplierCounterparty(supplierId, { refKey1c, expectedRefKey1c: link.refKey1c })');
    expect(card).toMatch(/if \(!supplierId \|\| !link \|\| saving\) return;/);
  });
});
