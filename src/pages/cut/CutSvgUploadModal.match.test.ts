import { describe, expect, it } from 'vitest';
import { buildSvgMatchProblems } from './CutSvgUploadModal';
import type { EligibleDetailDto, CutJobRef } from '../../api/types/cutApi.types';

const item = { orderName: '2950', detailNumber: 10, widthMm: 2700, heightMm: 34, quantity: 1,
  xMm: 0, yMm: 0, placedWidthMm: 34, placedHeightMm: 2700, rotated: true, sourceElementId: 'strip' };
const job = (id: number, mode: string | null): CutJobRef => ({ cutJobId: id, name: `Job ${id}`,
  paramProfileId: id, profileName: 'Renamed profile', profileIsActive: false, profileLayoutMode: mode });
function problems(jobs: CutJobRef[], width = 34) {
  const detail = { orderName: '2950', detailNumber: 10, width, height: 2700, quantity: 1, activeJobs: jobs } as EligibleDetailDto;
  return buildSvgMatchProblems([item], [detail]);
}
describe('SVG placement warnings', () => {
  it('omits vacuum baths even when their names and profile activity differ', () => {
    expect(problems([job(629, 'vacuum_table')])).toEqual([]);
  });
  it('keeps ordinary and unspecified profiles in mixed placement warnings', () => {
    const result = problems([job(629, 'vacuum_table'), job(630, 'guillotine'), job(631, null)]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).not.toContain('629');
    expect(result[0].reason).toContain('630');
    expect(result[0].reason).toContain('631');
  });
  it('still reports real size mismatches when all placements are vacuum baths', () => {
    expect(problems([job(629, 'vacuum_table')], 231)[0]).toMatchObject({ severity: 'error' });
  });
});
