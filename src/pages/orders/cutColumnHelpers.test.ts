import { describe, it, expect } from 'vitest';
import {
  areCutJobLinkMapsEqual,
  buildCutJobByDetailId,
  buildCutJobLinkMaps,
  buildCutJobLinkMapsFromDetails,
  buildOrderDetailLiveCellRenderVersion,
  cutJobDeepLink,
  cutJobProfileLabel,
  cutJobVersionLabel,
  mergeCutJobLinkMaps,
} from './cutColumnHelpers';

describe('cutColumnHelpers', () => {
  it('buildCutJobByDetailId maps each detail to its ref', () => {
    const map = buildCutJobByDetailId([
      {
        orderDetailId: 1,
        cutJob: { cutJobId: 9, resultNo: 2, cutNumber: '9-2', name: 'A', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: null,
      },
      {
        orderDetailId: 2,
        cutJob: { cutJobId: 9, resultNo: 2, cutNumber: '9-2', name: 'A', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: null,
      },
    ]);
    expect(map.get(1)?.cutJobId).toBe(9);
    expect(map.get(2)?.name).toBe('A');
    expect(map.has(3)).toBe(false);
  });

  it('buildCutJobLinkMaps splits regular and vacuum refs', () => {
    const maps = buildCutJobLinkMaps([
      {
        orderDetailId: 1,
        cutJob: { cutJobId: 9, resultNo: 2, cutNumber: '9-2', name: 'Regular', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: { cutJobId: 10, resultNo: 3, cutNumber: 'В-10-3', name: 'Bath', paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true },
      },
    ]);
    expect(maps.cutJobByDetailId.get(1)?.name).toBe('Regular');
    expect(maps.bathCutJobByDetailId.get(1)?.name).toBe('Bath');
  });

  it('buildCutJobLinkMapsFromDetails reads embedded order-detail refs', () => {
    const maps = buildCutJobLinkMapsFromDetails([
      {
        detail_id: 11,
        cut_job: { cutJobId: 41, resultNo: 2, cutNumber: '41-2', name: 'Раскрой заказа' },
        bath_cut_job: {
          cutJobId: 42,
          resultNo: 3,
          cutNumber: 'В-42-3',
          name: 'Ванна заказа',
          paramProfileId: '7',
          profileName: 'Вакуум',
          profileIsActive: true,
        },
      },
    ]);
    expect(maps.cutJobByDetailId.get(11)).toMatchObject({ cutJobId: 41, resultNo: 2, name: 'Раскрой заказа' });
    expect(maps.bathCutJobByDetailId.get(11)).toMatchObject({
      cutJobId: 42,
      resultNo: 3,
      name: 'Ванна заказа',
      paramProfileId: 7,
    });
  });

  it('mergeCutJobLinkMaps lets live refs override embedded snapshot refs', () => {
    const embedded = buildCutJobLinkMapsFromDetails([
      {
        detail_id: 11,
        cut_job: { cutJobId: 41, resultNo: 2, cutNumber: '41-2', name: 'Snapshot' },
      },
    ]);
    const live = buildCutJobLinkMaps([
      {
        orderDetailId: 11,
        cutJob: { cutJobId: 43, resultNo: 4, cutNumber: '43-4', name: 'Live', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: null,
      },
    ]);
    expect(mergeCutJobLinkMaps(embedded, live).cutJobByDetailId.get(11)?.name).toBe('Live');
  });

  it('detects unchanged and changed live cut version snapshots', () => {
    const first = buildCutJobLinkMaps([
      {
        orderDetailId: 1,
        cutJob: { cutJobId: 9, resultNo: 2, cutNumber: '9-2', name: 'Regular', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: { cutJobId: 10, resultNo: 3, cutNumber: 'В-10-3', name: 'Bath', paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true },
      },
    ]);
    const unchanged = buildCutJobLinkMaps([
      {
        orderDetailId: 1,
        cutJob: { cutJobId: 9, resultNo: 2, cutNumber: '9-2', name: 'Regular', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: { cutJobId: 10, resultNo: 3, cutNumber: 'В-10-3', name: 'Bath', paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true },
      },
    ]);
    const changed = buildCutJobLinkMaps([
      {
        orderDetailId: 1,
        cutJob: { cutJobId: 9, resultNo: 4, cutNumber: '9-4', name: 'Regular', paramProfileId: null, profileName: null, profileIsActive: null },
        bathCutJob: { cutJobId: 10, resultNo: 3, cutNumber: 'В-10-3', name: 'Bath', paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true },
      },
    ]);

    expect(areCutJobLinkMapsEqual(first, unchanged)).toBe(true);
    expect(areCutJobLinkMapsEqual(first, changed)).toBe(false);
  });

  it('versions every external source used by live order-detail cells', () => {
    const cutRef = {
      cutJobId: 9,
      resultNo: 2,
      cutNumber: '9-2',
      name: 'Regular',
      paramProfileId: null,
      profileName: null,
      profileIsActive: null,
    };
    const bathRef = { ...cutRef, cutJobId: 10, cutNumber: 'В-10-2', name: 'Bath' };
    const input = {
      currentDetailProductionStatusById: new Map([[1, 4]]),
      productionStatusesById: new Map([[4, { name: 'В работе', color: '#1677ff' }]]),
      productionStatusesLoading: false,
      cutJobByDetailId: new Map([[1, cutRef]]),
      bathCutJobByDetailId: new Map([[1, bathRef]]),
    };
    const version = buildOrderDetailLiveCellRenderVersion(input);

    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      currentDetailProductionStatusById: new Map([[1, 4]]),
      productionStatusesById: new Map([[4, { name: 'В работе', color: '#1677ff' }]]),
      cutJobByDetailId: new Map([[1, { ...cutRef }]]),
      bathCutJobByDetailId: new Map([[1, { ...bathRef }]]),
    })).toBe(version);
    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      currentDetailProductionStatusById: new Map([[1, 5]]),
    })).not.toBe(version);
    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      productionStatusesById: new Map([[4, { name: 'Готово', color: '#52c41a' }]]),
    })).not.toBe(version);
    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      productionStatusesLoading: true,
    })).not.toBe(version);
    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      cutJobByDetailId: new Map([[1, { ...cutRef, resultNo: 3, cutNumber: '9-3' }]]),
    })).not.toBe(version);
    expect(buildOrderDetailLiveCellRenderVersion({
      ...input,
      bathCutJobByDetailId: new Map([[1, { ...bathRef, resultNo: 3, cutNumber: 'В-10-3' }]]),
    })).not.toBe(version);
  });

  it('cutJobDeepLink builds the /cut?job= path', () => {
    expect(cutJobDeepLink(45)).toBe('/cut?job=45');
    expect(cutJobDeepLink(45, 3)).toBe('/cut?job=45&result=3');
    expect(cutJobDeepLink({ cutJobId: 45, resultNo: 3 })).toBe('/cut?job=45&result=3');
  });

  it('cutJobVersionLabel prefers the current result cut number', () => {
    expect(cutJobVersionLabel({ cutJobId: 45, resultNo: 3, cutNumber: '45-3' })).toBe('45-3');
    expect(cutJobVersionLabel({ cutJobId: 45, resultNo: 3, cutNumber: 'В-45-3' })).toBe('В-45-3');
    expect(cutJobVersionLabel({ cutJobId: 45, resultNo: 3, cutNumber: '   ' })).toBe('45-3');
  });

  it('cutJobProfileLabel resolves profile display names', () => {
    expect(cutJobProfileLabel({ paramProfileId: null, profileName: null, profileIsActive: null })).toBe('По умолчанию');
    expect(cutJobProfileLabel({ paramProfileId: 7, profileName: 'Вакуумный стол', profileIsActive: true })).toBe('Вакуумный стол');
    expect(cutJobProfileLabel({ paramProfileId: 8, profileName: 'Архивный', profileIsActive: false })).toBe('Архивный (неактивен)');
    expect(cutJobProfileLabel({ paramProfileId: 9, profileName: null, profileIsActive: null })).toBe('Профиль #9');
  });
});
