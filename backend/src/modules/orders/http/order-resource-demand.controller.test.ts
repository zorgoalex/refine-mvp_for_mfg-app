import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { parseOrderResourceDemandQuery } from './order-resource-demand.controller';

describe('parseOrderResourceDemandQuery', () => {
  it('parses paging, period, material and provider filters', () => {
    expect(parseOrderResourceDemandQuery({
      page: '2',
      pageSize: '50',
      search: ' МП-100 ',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      sheetMaterialTypeId: '10',
      filmId: '20',
      supplierId: '30',
      vendorId: '40',
    })).toEqual({
      page: 2,
      pageSize: 50,
      search: 'МП-100',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      sheetMaterialTypeId: 10,
      filmId: 20,
      supplierId: 30,
      vendorId: 40,
    });
  });

  it('uses bounded defaults', () => {
    expect(parseOrderResourceDemandQuery({})).toEqual({ page: 1, pageSize: 20 });
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ pageSize: '101' }, 'pageSize'],
    [{ dateFrom: '31.07.2026' }, 'dateFrom'],
    [{ dateFrom: '2026-08-01', dateTo: '2026-07-31' }, 'dateFrom'],
    [{ supplierId: '-1' }, 'supplierId'],
    [{ filmId: ['1', '2'] }, 'filmId'],
  ])('rejects invalid query %o', (query, field) => {
    expect(() => parseOrderResourceDemandQuery(query)).toThrow(ApiError);
    try {
      parseOrderResourceDemandQuery(query);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, details: { field } });
    }
  });
});
