import { describe, expect, it } from 'vitest';
import type { OrderSnapshotDto } from '../dto/order-snapshot.dto';
import { validateSnapshotStageRoutes } from './pg-order-snapshot';

const snapshot = (stageRoutes: unknown, lastRoundNo?: number) => ({
  data: {
    details: [{ sourceId: '10' }, { sourceId: '11' }],
    ...(lastRoundNo === undefined ? {} : { productionRounds: { lastRoundNo } }),
    stageRoutes,
  },
}) as unknown as OrderSnapshotDto;

describe('snapshot «Базис» routes (migration 282)', () => {
  it('accepts routes of its own details in known rounds; a file without routes is fine', () => {
    expect(() => validateSnapshotStageRoutes(snapshot([{ detailSourceId: '10', roundNo: 1 }]))).not.toThrow();
    expect(() => validateSnapshotStageRoutes(snapshot([{ detailSourceId: '11', roundNo: 2 }], 2))).not.toThrow();
    expect(() => validateSnapshotStageRoutes(snapshot(undefined))).not.toThrow();
  });

  it.each([
    ['an unknown detail', [{ detailSourceId: '99', roundNo: 1 }], undefined],
    ['a round 2 in a file without rounds', [{ detailSourceId: '10', roundNo: 2 }], undefined],
    ['a round after the last one', [{ detailSourceId: '10', roundNo: 3 }], 2],
    ['the same route twice', [{ detailSourceId: '10', roundNo: 1 }, { detailSourceId: '10', roundNo: 1 }], undefined],
    ['an extra field', [{ detailSourceId: '10', roundNo: 1, variant: 'cnc' }], undefined],
  ])('refuses %s before anything is written', (_name, routes, lastRound) => {
    expect(() => validateSnapshotStageRoutes(snapshot(routes, lastRound)))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_STAGE_ROUTES_INVALID' }));
  });
});
