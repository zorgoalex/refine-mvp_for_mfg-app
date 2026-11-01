import { describe, expect, it } from 'vitest';
import type { OrderSnapshotDto, OrderSnapshotProductionRoundDto } from '../dto/order-snapshot.dto';
import { snapshotHasProductionRounds, validateSnapshotProductionRounds } from './pg-order-snapshot-rounds';

function round(roundNo: number, overrides: Partial<OrderSnapshotProductionRoundDto> = {}): OrderSnapshotProductionRoundDto {
  return {
    roundNo, mode: 'after_ready', reasonCode: 'workshop_defect', reasonName: 'Брак цеха', reasonComment: null,
    fromOrderStatusId: 6, fromOrderProductionRound: roundNo - 1, source: 'manual', sourceCutJobId: null,
    sourcePacketId: null, startedAt: '2026-09-29T10:00:00.000Z', startedBy: null, reasonClarifiedAt: null,
    reasonClarifiedBy: null, closedAt: '2026-09-29T11:00:00.000Z', closedBy: null, closeReason: 'ready', eventSeq: 1,
    details: [{ detailSourceId: 'd1', fromProductionStatusId: 7, fromProductionRound: roundNo - 1, fromProductionStatusSort: 80,
      toProductionStatusId: 1, addedAt: '2026-09-29T10:00:00.000Z', addedBySource: 'start' }],
    sources: [],
    ...overrides,
  };
}

function snapshot(data: Partial<OrderSnapshotDto['data']> = {}, formatVersion: OrderSnapshotDto['formatVersion'] = '1.1.0'): OrderSnapshotDto {
  return {
    formatVersion,
    data: {
      details: [{ sourceId: 'd1' }, { sourceId: 'd2' }],
      productionStatusEvents: [{ sourceId: 'e1', roundNo: 1 }],
      productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [{ detailSourceId: 'd1', productionRound: 2 }], rounds: [round(2)] },
      ...data,
    },
  } as unknown as OrderSnapshotDto;
}

const code = (fn: () => void) => {
  try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code; }
};

describe('validateSnapshotProductionRounds («Переделка» §6.2)', () => {
  it('accepts a consistent 1.1.0 round state and a plain 1.0.0 snapshot', () => {
    expect(code(() => validateSnapshotProductionRounds(snapshot()))).toBe('ok');
    expect(code(() => validateSnapshotProductionRounds(snapshot({ productionRounds: undefined,
      productionStatusEvents: [] as never }, '1.0.0')))).toBe('ok');
    expect(snapshotHasProductionRounds(snapshot())).toBe(true);
    expect(snapshotHasProductionRounds(snapshot({ productionRounds: undefined }))).toBe(false);
  });

  it('accepts «Это не переделка» history: reverted details, order back in round 1, a later round from round 1', () => {
    expect(code(() => validateSnapshotProductionRounds(snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd2', productionRound: 3 }],
      rounds: [
        round(2, { closeReason: 'false_positive' }),
        round(3, { fromOrderProductionRound: 1, closedAt: null, closeReason: null,
          details: [{ ...round(3).details[0], detailSourceId: 'd2', fromProductionRound: 1 }] }),
      ],
    } })))).toBe('ok');
  });

  it.each([
    ['1.0.0 with rounds', snapshot({}, '1.0.0')],
    ['1.0.0 with event roundNo', snapshot({ productionRounds: undefined }, '1.0.0')],
    ['two open rounds', snapshot({ productionRounds: { productionRound: 3, lastRoundNo: 3, detailRounds: [],
      rounds: [round(2, { closedAt: null, closeReason: null }), round(3, { closedAt: null, closeReason: null, fromOrderProductionRound: 2 })] } })],
    ['open round is not the current round', snapshot({ productionRounds: { productionRound: 1, lastRoundNo: 2, detailRounds: [],
      rounds: [round(2, { closedAt: null, closeReason: null })] } })],
    ['duplicate round', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [], rounds: [round(2), round(2)] } })],
    ['closed without reason', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [],
      rounds: [round(2, { closeReason: null })] } })],
    ['detail round above the order round', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 3 }],
      rounds: [round(2), round(3, { fromOrderProductionRound: 2 })] } })],
    ['lastRoundNo below the current round', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 1, detailRounds: [], rounds: [round(2)] } })],
    ['unknown detail', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [{ detailSourceId: 'x', productionRound: 2 }], rounds: [round(2)] } })],
    ['round detail from a later round', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [],
      rounds: [round(2, { details: [{ ...round(2).details[0], fromProductionRound: 2 }] })] } })],
    ['event of an unknown round', snapshot({ productionStatusEvents: [{ sourceId: 'e1', roundNo: 5 }] as never })],
    ['member of a live round left at round 1 (detailRounds entry dropped)', snapshot({ productionRounds: {
      productionRound: 2, lastRoundNo: 2, detailRounds: [], rounds: [round(2, { closedAt: null, closeReason: null })] } })],
    ['detail in a round it was never added to', snapshot({ productionRounds: {
      productionRound: 2, lastRoundNo: 2, detailRounds: [{ detailSourceId: 'd1', productionRound: 2 }, { detailSourceId: 'd2', productionRound: 2 }],
      rounds: [round(2)] } })],
    ['order before-state points to an absent round', snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 3 }],
      rounds: [round(3, { closedAt: null, closeReason: null, details: [{ ...round(3).details[0], fromProductionRound: 1 }] })] } })],
    ['detail before-state points to an absent round', snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 3 }],
      rounds: [round(3, { fromOrderProductionRound: 1, closedAt: null, closeReason: null })] } })],
    ['open round restores the order to a cancelled round', snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 3 }],
      rounds: [round(2, { closeReason: 'false_positive' }),
        round(3, { fromOrderProductionRound: 2, closedAt: null, closeReason: null,
          details: [{ ...round(3).details[0], fromProductionRound: 1 }] })] } })],
    ['detail restored into a round it never belonged to', snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 2 }, { detailSourceId: 'd2', productionRound: 3 }],
      rounds: [round(2),
        round(3, { fromOrderProductionRound: 2, closedAt: null, closeReason: null,
          details: [{ ...round(3).details[0], detailSourceId: 'd2', fromProductionRound: 2 }] })] } })],
    ['cancelling restores a live-round member below that round', snapshot({ productionRounds: {
      productionRound: 3, lastRoundNo: 3, detailRounds: [{ detailSourceId: 'd1', productionRound: 3 }],
      rounds: [round(2),
        round(3, { fromOrderProductionRound: 2, closedAt: null, closeReason: null,
          details: [{ ...round(3).details[0], fromProductionRound: 1 }] })] } })],
    ['current round is a false-positive round', snapshot({ productionRounds: {
      productionRound: 2, lastRoundNo: 2, detailRounds: [], rounds: [round(2, { closeReason: 'false_positive' })] } })],
    ['unknown field', snapshot({ productionRounds: { productionRound: 2, lastRoundNo: 2, detailRounds: [], rounds: [{ ...round(2), extra: 1 } as never] } })],
  ])('rejects %s with 422 SNAPSHOT_ROUNDS_INVALID', (_label, input) => {
    expect(code(() => validateSnapshotProductionRounds(input))).toBe('SNAPSHOT_ROUNDS_INVALID');
  });
});
