import { describe, expect, it } from 'vitest';
import type { BazisProjectListItem } from '../../api/types/bazisApi.types';
import { bazisProjectsCountLabel, filterBazisProjects, latestBazisImport } from './bazisListView';

const project = (patch: Partial<BazisProjectListItem>): BazisProjectListItem => ({
  bazisProjectId: 1,
  projectId: 10,
  projectName: null,
  name: 'Проект',
  revisionsCount: 1,
  lastRevisionNo: 1,
  lastImportedAt: null,
  bazisOrderNo: null,
  designEngineerId: null,
  designEngineerName: null,
  designEngineerXmlName: null,
  designEngineerSource: null,
  linkedOrderIds: [],
  linkedOrders: [],
  ...patch,
});

const rows = [
  project({ bazisProjectId: 1, name: '1665', bazisOrderNo: '1665', projectId: 5037, linkedOrderIds: [11713], linkedOrders: [{ orderId: 11713, orderName: '2963', orderDeleted: false }], lastImportedAt: '2026-09-23T11:15:00Z' }),
  project({ bazisProjectId: 2, name: '1690.xml', projectId: 5130, designEngineerName: 'Тестов Иван', lastImportedAt: '2026-10-15T12:36:00Z' }),
  project({ bazisProjectId: 3, name: 'Кухня', lastImportedAt: 'не дата' }),
];

describe('Bazis project list (NewLine)', () => {
  it('filters by link to orders', () => {
    expect(filterBazisProjects(rows, '', 'all').map((row) => row.bazisProjectId)).toEqual([1, 2, 3]);
    expect(filterBazisProjects(rows, '', 'linked').map((row) => row.bazisProjectId)).toEqual([1]);
    expect(filterBazisProjects(rows, '', 'free').map((row) => row.bazisProjectId)).toEqual([2, 3]);
  });

  it('searches by name, ERP project, order and design engineer', () => {
    expect(filterBazisProjects(rows, ' КУХ ', 'all').map((row) => row.bazisProjectId)).toEqual([3]);
    expect(filterBazisProjects(rows, '#5130', 'all').map((row) => row.bazisProjectId)).toEqual([2]);
    expect(filterBazisProjects(rows, '2963', 'all').map((row) => row.bazisProjectId)).toEqual([1]);
    expect(filterBazisProjects(rows, '#11713', 'all').map((row) => row.bazisProjectId)).toEqual([1]);
    expect(filterBazisProjects(rows, 'тестов', 'free').map((row) => row.bazisProjectId)).toEqual([2]);
    expect(filterBazisProjects(rows, 'тестов', 'linked')).toEqual([]);
  });

  it('finds the latest import and skips broken dates', () => {
    expect(latestBazisImport(rows)?.toISOString()).toBe('2026-10-15T12:36:00.000Z');
    expect(latestBazisImport([rows[2]])).toBeNull();
    expect(latestBazisImport([])).toBeNull();
  });

  it('pluralizes the project count', () => {
    expect([0, 1, 2, 5, 11, 12, 21, 24, 27, 111].map(bazisProjectsCountLabel)).toEqual([
      '0 проектов', '1 проект', '2 проекта', '5 проектов', '11 проектов', '12 проектов', '21 проект', '24 проекта', '27 проектов', '111 проектов',
    ]);
  });
});
