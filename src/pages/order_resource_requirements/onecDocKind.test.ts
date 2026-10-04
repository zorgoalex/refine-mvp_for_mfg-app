import { describe, expect, it } from 'vitest';

import {
  isOnecPaymentKind,
  isOnecReceiptKind,
  onecDocKindLabel,
  onecDocKindShortLabel,
  onecDocumentListPath,
  onecDocumentShowPath,
  onecDocumentStatus,
  onecDocumentStatusLabel,
  onecDocumentStatusTagColor,
  orderResourceRequirementsOnecFilterPath,
} from './onecDocKind';

describe('onecDocKind labels', () => {
  it('labels each document kind in Russian', () => {
    expect(onecDocKindLabel('purchase_receipt')).toBe('Поступление товаров и услуг');
    expect(onecDocKindLabel('cash_outflow')).toBe('Расходный кассовый ордер');
    expect(onecDocKindLabel('bank_outflow')).toBe('Списание со счёта');
  });

  it('short-labels each document kind', () => {
    expect(onecDocKindShortLabel('purchase_receipt')).toBe('Приход');
    expect(onecDocKindShortLabel('cash_outflow')).toBe('РКО');
    expect(onecDocKindShortLabel('bank_outflow')).toBe('Списание');
  });

  it('classifies receipt vs payment kinds', () => {
    expect(isOnecReceiptKind('purchase_receipt')).toBe(true);
    expect(isOnecPaymentKind('purchase_receipt')).toBe(false);
    expect(isOnecReceiptKind('cash_outflow')).toBe(false);
    expect(isOnecPaymentKind('cash_outflow')).toBe(true);
    expect(isOnecReceiptKind('bank_outflow')).toBe(false);
    expect(isOnecPaymentKind('bank_outflow')).toBe(true);
  });
});

describe('onec document routes', () => {
  it('builds the document card path', () => {
    expect(onecDocumentShowPath(42)).toBe('/procurement/onec-documents/show/42');
  });

  it('builds the document list path', () => {
    expect(onecDocumentListPath()).toBe('/procurement/onec-documents');
  });

  it('builds the deep link to the resource requirements list filtered by this document', () => {
    expect(orderResourceRequirementsOnecFilterPath(42)).toBe('/order-resource-requirements?onecDocumentId=42');
  });
});

describe('onec document status', () => {
  it('prioritizes deleted over posted', () => {
    expect(onecDocumentStatus(true, true)).toBe('deleted');
    expect(onecDocumentStatus(false, true)).toBe('deleted');
  });

  it('distinguishes posted from unposted when not deleted', () => {
    expect(onecDocumentStatus(true, false)).toBe('posted');
    expect(onecDocumentStatus(false, false)).toBe('unposted');
  });

  it('labels and colors match status', () => {
    expect(onecDocumentStatusLabel(true, false)).toBe('проведён');
    expect(onecDocumentStatusLabel(false, false)).toBe('не проведён');
    expect(onecDocumentStatusLabel(false, true)).toBe('удалён в 1С');
    expect(onecDocumentStatusTagColor(true, false)).toBe('success');
    expect(onecDocumentStatusTagColor(false, false)).toBeUndefined();
    expect(onecDocumentStatusTagColor(false, true)).toBe('error');
  });
});
