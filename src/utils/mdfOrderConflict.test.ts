import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/apiError';
import {
  awaitMdfConfirmation,
  buildMdfConfirmationHeaders,
  buildMdfOrderConflictViewModel,
  isMdfOrderConflictError,
  isMdfOrderConflictRetryable,
} from './mdfOrderConflict';

function makeError(code: string, details?: unknown, message = 'Операция отклонена') {
  return new ApiError({ code, message, status: 409, details });
}

const VALID_DIGEST = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('isMdfOrderConflictError', () => {
  it('detects all known MDF board conflict codes', () => {
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_PHYSICAL_CONFLICT'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_ASSIGNMENT_CONFLICT'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_SOURCE_PENDING'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_SOURCE_ATTENTION'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_DEMAND_EMPTY'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_LOCK_CONTENTION'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ORDER_SCOPE_LIMIT'))).toBe(true);
    expect(isMdfOrderConflictError(makeError('MDF_ENGINE_READ_ONLY'))).toBe(true);
  });

  it('returns false for unrelated codes and non-ApiError values', () => {
    expect(isMdfOrderConflictError(makeError('ORDER_NAME_DUPLICATE'))).toBe(false);
    expect(isMdfOrderConflictError(makeError('ORDER_VERSION_CONFLICT'))).toBe(false);
    expect(isMdfOrderConflictError(new Error('plain error'))).toBe(false);
    expect(isMdfOrderConflictError(null)).toBe(false);
    expect(isMdfOrderConflictError(undefined)).toBe(false);
  });
});

describe('buildMdfOrderConflictViewModel: unknown / non-MDF errors', () => {
  it('returns null for an unrelated ApiError code', () => {
    expect(buildMdfOrderConflictViewModel(makeError('ORDER_NAME_DUPLICATE'))).toBeNull();
  });

  it('returns null for a plain Error', () => {
    expect(buildMdfOrderConflictViewModel(new Error('boom'))).toBeNull();
  });

  it('returns null for non-error values', () => {
    expect(buildMdfOrderConflictViewModel(null)).toBeNull();
    expect(buildMdfOrderConflictViewModel({ code: 'MDF_ORDER_PHYSICAL_CONFLICT' })).toBeNull();
  });
});

describe('buildMdfOrderConflictViewModel: retryable-only codes', () => {
  it('flags MDF_ORDER_LOCK_CONTENTION as retryable', () => {
    const vm = buildMdfOrderConflictViewModel(makeError('MDF_ORDER_LOCK_CONTENTION', undefined, 'Карточка занята'));
    expect(vm).not.toBeNull();
    expect(vm?.retryable).toBe(true);
    expect(vm?.message).toBe('Карточка занята');
    expect(vm?.title).toBe('Карточка МДФ занята');
  });

  it('flags MDF_ORDER_SOURCE_PENDING as retryable', () => {
    const vm = buildMdfOrderConflictViewModel(makeError('MDF_ORDER_SOURCE_PENDING'));
    expect(vm?.retryable).toBe(true);
  });

  it('flags every other code as not retryable', () => {
    for (const code of [
      'MDF_ORDER_SOURCE_ATTENTION',
      'MDF_ORDER_PHYSICAL_CONFLICT',
      'MDF_ORDER_ASSIGNMENT_CONFLICT',
      'MDF_ORDER_DEMAND_EMPTY',
      'MDF_ORDER_SCOPE_LIMIT',
      'MDF_ENGINE_READ_ONLY',
    ]) {
      expect(isMdfOrderConflictRetryable(code as any)).toBe(false);
    }
  });
});

describe('buildMdfOrderConflictViewModel: cards', () => {
  it('formats card kind labels, positions, and a removed position', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        {
          reason: 'MDF_ORDER_PHYSICAL_CONFLICT',
          sourceKind: 'packet',
          sourceId: 'p-1',
          displayName: 'ЧПУ-14',
          orderIds: [101],
          hiddenOwners: false,
          positions: [
            { orderId: 101, detailId: 555, before: 5, after: 3 },
            { orderId: 101, detailId: 556, before: 2, after: null },
          ],
        },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm).not.toBeNull();
    expect(vm?.cards).toHaveLength(1);
    const card = vm!.cards[0];
    expect(card.header).toBe('Файл станка «ЧПУ-14»');
    expect(card.hiddenOwners).toBe(false);
    expect(card.positions).toEqual([
      expect.objectContaining({ detailId: 555, before: 5, after: 3, line: 'деталь #555: было 5 → станет 3' }),
      expect.objectContaining({ detailId: 556, before: 2, after: null, line: 'деталь #556: было 2 → станет удалена' }),
    ]);
    expect(vm?.hasHiddenOwners).toBe(false);
    expect(vm?.hiddenOwnersNote).toBeNull();
  });

  it('labels bazisCutSet and bath source kinds', () => {
    const error = makeError('MDF_ORDER_ASSIGNMENT_CONFLICT', {
      cards: [
        { sourceKind: 'bazisCutSet', displayName: 'Набор A', hiddenOwners: false, positions: [] },
        { sourceKind: 'bath', displayName: 'Ванна 2', hiddenOwners: false, positions: [] },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.cards.map((c) => c.header)).toEqual(['Набор Базис «Набор A»', 'Ванна «Ванна 2»']);
  });

  it('uses a fallback name and sets hasHiddenOwners/hiddenOwnersNote when a card hides its owner', () => {
    const error = makeError('MDF_ORDER_ASSIGNMENT_CONFLICT', {
      cards: [
        {
          sourceKind: 'packet',
          displayName: null,
          hiddenOwners: true,
          positions: [{ orderId: 202, detailId: 9, before: 1, after: 1 }],
        },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.cards[0].header).toBe('Файл станка «карточка другого заказа»');
    expect(vm?.hasHiddenOwners).toBe(true);
    expect(vm?.hiddenOwnersNote).toBe('Есть карточки с заказами, которые вам не видны');
  });

  it('prefers the hidden fallback name even if displayName leaked through when hiddenOwners is true', () => {
    const error = makeError('MDF_ORDER_ASSIGNMENT_CONFLICT', {
      cards: [
        { sourceKind: 'packet', displayName: 'Чужой заказ 42', hiddenOwners: true, positions: [] },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.cards[0].header).toBe('Файл станка «карточка другого заказа»');
  });

  it('does not set the hidden-owners note when no card hides its owner', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        { sourceKind: 'packet', displayName: 'A', hiddenOwners: false, positions: [] },
        { sourceKind: 'bath', displayName: 'B', hiddenOwners: false, positions: [] },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.hasHiddenOwners).toBe(false);
    expect(vm?.hiddenOwnersNote).toBeNull();
  });

  it('sets hasHiddenOwners true when only one of several cards hides its owner', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        { sourceKind: 'packet', displayName: 'A', hiddenOwners: false, positions: [] },
        { sourceKind: 'bath', displayName: null, hiddenOwners: true, positions: [] },
      ],
    });

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.hasHiddenOwners).toBe(true);
  });

  it('tolerates missing/malformed details gracefully (no cards, empty array)', () => {
    expect(buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY'))?.cards).toEqual([]);
    expect(buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY', {}))?.cards).toEqual([]);
    expect(buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY', { cards: 'nope' }))?.cards).toEqual([]);
    expect(
      buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY', { cards: [null, 42, 'x'] }))?.cards,
    ).toHaveLength(3);
  });

  it('falls back to an unknown sourceKind label when the kind is not recognized', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [{ sourceKind: 'weird', displayName: 'X', hiddenOwners: false, positions: [] }],
    });
    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.cards[0].header).toBe('weird «X»');
  });
});

describe('buildMdfOrderConflictViewModel: MDF_ORDER_CONFIRMATION_STALE', () => {
  it('detects the code, is not retryable, and carries the fresh cards/title', () => {
    const error = makeError('MDF_ORDER_CONFIRMATION_STALE', {
      cards: [
        { sourceKind: 'packet', displayName: 'ЧПУ-14', hiddenOwners: false, positions: [] },
      ],
      mdfConfirmation: { digest: VALID_DIGEST },
    });

    expect(isMdfOrderConflictError(error)).toBe(true);

    const vm = buildMdfOrderConflictViewModel(error);
    expect(vm?.code).toBe('MDF_ORDER_CONFIRMATION_STALE');
    expect(vm?.title).toBe('Состояние МДФ-доски изменилось');
    expect(vm?.retryable).toBe(false);
    expect(vm?.cards).toHaveLength(1);
    expect(vm?.confirmationDigest).toBe(VALID_DIGEST);
  });
});

describe('buildMdfOrderConflictViewModel: confirmationDigest extraction', () => {
  it('extracts a valid 64-char lowercase-hex digest from details.mdfConfirmation.digest', () => {
    const vm = buildMdfOrderConflictViewModel(
      makeError('MDF_ORDER_DEMAND_EMPTY', { mdfConfirmation: { digest: VALID_DIGEST } }),
    );
    expect(vm?.confirmationDigest).toBe(VALID_DIGEST);
  });

  it('returns null when mdfConfirmation is absent', () => {
    expect(buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY'))?.confirmationDigest).toBeNull();
    expect(
      buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY', {}))?.confirmationDigest,
    ).toBeNull();
  });

  it('returns null when the digest is malformed (wrong length, uppercase, non-hex, wrong type)', () => {
    const casesDetails = [
      { mdfConfirmation: { digest: 'abc' } },
      { mdfConfirmation: { digest: VALID_DIGEST.toUpperCase() } },
      { mdfConfirmation: { digest: `${VALID_DIGEST.slice(0, 63)}z` } },
      { mdfConfirmation: { digest: 12345 } },
      { mdfConfirmation: { digest: null } },
      { mdfConfirmation: 'nope' },
    ];
    for (const details of casesDetails) {
      expect(
        buildMdfOrderConflictViewModel(makeError('MDF_ORDER_DEMAND_EMPTY', details))?.confirmationDigest,
      ).toBeNull();
    }
  });

  it('is null for codes that never carry a preview (e.g. LOCK_CONTENTION)', () => {
    expect(
      buildMdfOrderConflictViewModel(
        makeError('MDF_ORDER_LOCK_CONTENTION', { mdfConfirmation: { digest: VALID_DIGEST } }),
      )?.confirmationDigest,
    ).toBe(VALID_DIGEST);
  });
});

describe('buildMdfConfirmationHeaders', () => {
  it('builds the single X-MDF-Confirmation header from the digest', () => {
    expect(buildMdfConfirmationHeaders(VALID_DIGEST)).toEqual({
      'X-MDF-Confirmation': VALID_DIGEST,
    });
  });
});

describe('buildMdfOrderConflictViewModel: position stats and outcome line text', () => {
  it('keeps the plain before/after line unchanged when cut/laminated/reserved/outcome are absent', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        {
          sourceKind: 'packet',
          displayName: 'ЧПУ-14',
          hiddenOwners: false,
          positions: [{ orderId: 101, detailId: 12, before: 10, after: 6 }],
        },
      ],
    });
    const vm = buildMdfOrderConflictViewModel(error);
    const position = vm!.cards[0].positions[0];
    expect(position.line).toBe('деталь #12: было 10 → станет 6');
    expect(position.cut).toBeUndefined();
    expect(position.laminated).toBeUndefined();
    expect(position.reserved).toBeUndefined();
    expect(position.outcome).toBeUndefined();
  });

  it('renders cut/laminated/reserved plus the surplus outcome note', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        {
          sourceKind: 'packet',
          displayName: 'ЧПУ-14',
          hiddenOwners: false,
          positions: [
            {
              orderId: 101,
              detailId: 12,
              before: 10,
              after: 6,
              cut: 8,
              laminated: 0,
              reserved: 2,
              outcome: 'surplus',
            },
          ],
        },
      ],
    });
    const vm = buildMdfOrderConflictViewModel(error);
    const position = vm!.cards[0].positions[0];
    expect(position.line).toBe(
      'деталь #12: было 10 → станет 6 · распилено 8, закатано 0, в резерве 2 — лишнее станет излишком',
    );
    expect(position.cut).toBe(8);
    expect(position.laminated).toBe(0);
    expect(position.reserved).toBe(2);
    expect(position.outcome).toBe('surplus');
  });

  it('renders only the cut count plus the detached outcome note when after is removed', () => {
    const error = makeError('MDF_ORDER_ASSIGNMENT_CONFLICT', {
      cards: [
        {
          sourceKind: 'packet',
          displayName: 'ЧПУ-14',
          hiddenOwners: false,
          positions: [
            {
              orderId: 101,
              detailId: 12,
              before: 10,
              after: null,
              cut: 8,
              outcome: 'detached',
            },
          ],
        },
      ],
    });
    const vm = buildMdfOrderConflictViewModel(error);
    const position = vm!.cards[0].positions[0];
    expect(position.line).toBe(
      'деталь #12: было 10 → станет удалена · распилено 8 — позиция выбудет из учёта (история сохранится)',
    );
  });

  it('ignores an unrecognized outcome value and a non-numeric stat field', () => {
    const error = makeError('MDF_ORDER_PHYSICAL_CONFLICT', {
      cards: [
        {
          sourceKind: 'packet',
          displayName: 'ЧПУ-14',
          hiddenOwners: false,
          positions: [
            { orderId: 101, detailId: 12, before: 10, after: 6, cut: '8', outcome: 'weird' },
          ],
        },
      ],
    });
    const vm = buildMdfOrderConflictViewModel(error);
    const position = vm!.cards[0].positions[0];
    expect(position.line).toBe('деталь #12: было 10 → станет 6');
    expect(position.cut).toBeUndefined();
    expect(position.outcome).toBeUndefined();
  });
});

describe('awaitMdfConfirmation (§5.4e pending save)', () => {
  it('resolves with the resend result on confirm, passing the digest', async () => {
    const digests: string[] = [];
    const result = await awaitMdfConfirmation<number | null>(
      ({ onConfirm }) => { onConfirm('a'.repeat(64)); },
      async (digest) => { digests.push(digest); return 42; },
    );
    expect(result).toBe(42);
    expect(digests).toEqual(['a'.repeat(64)]);
  });

  it('resolves null on cancel and never resends', async () => {
    let resent = false;
    const result = await awaitMdfConfirmation(({ onCancel }) => { onCancel(); }, async () => { resent = true; return 1; });
    expect(result).toBeNull();
    expect(resent).toBe(false);
  });

  it('settles once: a late cancel after confirm does not override the resend result', async () => {
    const result = await awaitMdfConfirmation<number>(({ onConfirm, onCancel }) => { onConfirm('b'.repeat(64)); onCancel(); },
      async () => 7);
    expect(result).toBe(7);
  });

  it('propagates a resend rejection to the pending caller', async () => {
    await expect(awaitMdfConfirmation(({ onConfirm }) => { onConfirm('c'.repeat(64)); },
      async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
