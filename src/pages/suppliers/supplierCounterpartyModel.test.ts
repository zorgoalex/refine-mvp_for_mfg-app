import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import { counterpartyOptions, isCounterpartyApiMissing, onecProfileView, onecSyncMessage, supplierLinkErrorMessage } from './supplierCounterpartyModel';

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
    expect(read('./edit.tsx')).toContain('<SupplierCounterpartyCard supplierId={supplierId} editable={canManage} onContactsChanged=');
  });

  it('the link card sends the key it showed and locks while saving', () => {
    const card = read('./SupplierCounterpartyCard.tsx');
    expect(card).toContain('setSupplierCounterparty(supplierId, { refKey1c, expectedRefKey1c: link.refKey1c })');
    expect(card).toMatch(/if \(!supplierId \|\| !link \|\| saving \|\| contactsDirty\) return;/);
  });
});

describe('the 1C side of a supplier', () => {
  const profile = {
    sourceId: 1, refKey1c: 'a', counterpartyName: 'ТОО Альфа', identificationNumber: '123456789012', counterpartyState: 'active' as const,
    contactsState: 'available' as const, snapshotVersion: null, skipped: 0, syncedAt: '2026-10-21T05:30:00.000Z',
  };

  it('shows ИИН/БИН and the time of the last sync; warns about marks, revoked data and unreadable values', () => {
    expect(onecProfileView(profile, new Date('2026-10-21T09:00:00.000Z'))).toMatchObject({ identificationNumber: '123456789012', warnings: [] });
    expect(onecProfileView(profile, new Date('2026-10-21T09:00:00.000Z')).syncedText).toMatch(/^Сверено с 1С сегодня в /);
    expect(onecProfileView({ ...profile, identificationNumber: null, contactsState: 'unavailable', counterpartyState: 'deletion_mark', skipped: 2 }).warnings)
      .toEqual(['Контрагент помечен в 1С на удаление', 'Контакты из 1С сейчас недоступны и скрыты; при ближайшей сверке они будут удалены',
        'Не распознано значений из 1С: 2']);
    expect(onecProfileView(null)).toEqual({ identificationNumber: null, syncedText: null, warnings: [] });
  });

  it('words the outcome of «Сверить с 1С»', () => {
    expect(onecSyncMessage({ status: 'changed', added: 2, removed: 1, updated: 0, skipped: 0, contactsState: 'available' }))
      .toEqual({ type: 'success', text: 'Контакты из 1С обновлены: добавлено 2, удалено 1' });
    expect(onecSyncMessage({ status: 'unchanged', added: 0, removed: 0, updated: 0, skipped: 0, contactsState: 'available' }).type).toBe('info');
    expect(onecSyncMessage({ status: 'skipped', reason: 'not_loaded' }).type).toBe('warning');
  });
});

describe('a sync or a link change never reloads the contacts over unsaved edits', () => {
  it('the edit page passes the dirty state of the contacts to the 1C card, which holds back both actions', () => {
    const page = read('./edit.tsx');
    expect(page).toContain('onDirtyChange={setContactsDirty}');
    expect(page).toContain('contactsDirty={contactsDirty}');
    const card = read('./SupplierCounterpartyCard.tsx');
    expect(card).toContain('if (!supplierId || !link || saving || contactsDirty) return;');
    expect(card).toContain('if (!supplierId || syncing || contactsDirty) return;');
    expect(card.match(/disabled=\{[^}]*contactsDirty\}/g)?.length).toBeGreaterThanOrEqual(5);
    // And the other way: while a sync or a link change is in flight the contacts block takes no edits (its reload
    // after the answer locks it too).
    expect(card).toContain('useEffect(() => { onBusyChange?.(saving || syncing); }, [saving, syncing, onBusyChange]);');
    expect(page).toContain('locked={counterpartyBusy}');
    expect(page).toContain('onBusyChange={setCounterpartyBusy}');
  });
});
