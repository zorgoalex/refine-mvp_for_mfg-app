import { describe, expect, it } from 'vitest';
import type { ClientMergeHistory, MergeView } from '../../api/clientMergesApiTypes';
import {
  canConfirmUndo, mergedBanner, returnedLines, skippedKindLabel, skippedLine, skippedReasonLabel, undoButtonVisible,
} from './clientMergesModel';

const merge = (over: Partial<MergeView> = {}): MergeView => ({
  mergeId: 1, caseId: 2, status: 'done', survivor: { clientId: 10, name: 'Остаётся' }, merged: { clientId: 20, name: 'Уходит' },
  mergedAt: '2026-10-20T10:00:00Z', mergedBy: { userId: 5, username: 'ivan' }, undoUntil: '2026-11-19T10:00:00Z',
  undoneAt: null, undoneBy: null, counts: {}, undoReport: null, canUndo: true, ...over,
});

describe('client merges model', () => {
  it('labels skipped rows', () => {
    expect(skippedReasonLabel('group_moved')).toBe('группа передана другому клиенту');
    expect(skippedReasonLabel('zzz')).toBe('zzz');
    expect(skippedKindLabel('phone_key')).toBe('телефон');
    expect(skippedKindLabel('contact_email')).toBe('контакт');
    expect(skippedKindLabel('onec_link')).toBe('связь с 1С');
    expect(skippedLine({ kind: 'order', rowId: 7, reason: 'order_moved' })).toBe('заказ #7 — заказ перенесён в другую группу');
  });

  it('banner comes from the done merge of this client', () => {
    const history: ClientMergeHistory = {
      clientId: 20, mergedInto: { clientId: 10, name: 'Остаётся' },
      merges: [merge({ mergeId: 3, status: 'undone' }), merge()],
    };
    expect(mergedBanner(history, 20)).toEqual({ intoClientId: 10, intoName: 'Остаётся', mergedAt: '2026-10-20T10:00:00Z', mergedBy: 'ivan' });
    expect(mergedBanner({ ...history, mergedInto: null }, 20)).toBeNull();
    expect(mergedBanner(null, 20)).toBeNull();
    expect(mergedBanner(history, 99)?.mergedAt).toBeNull();
  });

  it('undo button state', () => {
    expect(undoButtonVisible(merge(), true)).toBe(true);
    expect(undoButtonVisible(merge(), false)).toBe(false);
    expect(undoButtonVisible(merge({ canUndo: false }), true)).toBe(false);
    expect(undoButtonVisible(merge({ status: 'undone' }), true)).toBe(false);
    expect(canConfirmUndo({ obstacles: [], previewToken: 't' }, false)).toBe(true);
    expect(canConfirmUndo({ obstacles: [], previewToken: null }, false)).toBe(false);
    expect(canConfirmUndo({ obstacles: [{}], previewToken: 't' }, false)).toBe(false);
  });

  it('returned lines skip zeros', () => {
    expect(returnedLines({ projects: 1, orders: 0, phones: 2 }).map((l) => l.label)).toEqual(['Групп', 'Телефонов']);
  });
});

import { saveErrorDescription } from './clientMergesModel';

describe('saveErrorDescription', () => {
  it('replaces the merged-client check text', () => {
    expect(saveErrorDescription('new row violates check constraint "chk_client_not_merged"'))
      .toBe('Клиент объединён с другим клиентом: его нельзя снова сделать активным');
    expect(saveErrorDescription('boom')).toBe('boom');
    expect(saveErrorDescription(undefined)).toBe('Неизвестная ошибка');
  });
});

import { returnedLines } from './clientMergesModel';

describe('report of an undo', () => {
  it('labels every returned count the backend gives and drops the zero ones', () => {
    expect(returnedLines({ orders: 2, phonesMoved: 1, phonesRestored: 1, contactsMoved: 0, contactsRestored: 1, redirectsRestored: 1 }).map((l) => l.label))
      .toEqual(['Заказов', 'Телефонов возвращено', 'Телефонов восстановлено', 'Контактов восстановлено', 'Ссылок объединения восстановлено']);
  });
});
