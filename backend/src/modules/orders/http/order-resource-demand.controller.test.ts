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

  it('parses header filters, the supplier keys, ready cuts and payment', () => {
    expect(parseOrderResourceDemandQuery({
      orderIds: '5,7,5',
      orderDates: '2026-10-01,none',
      sheetMaterialTypeIds: 'none',
      filmIds: '3,4',
      supplierKeys: 's:12,c:9b2f-11aa,n:0cc175b9c0f1b6a831c399e269772661,none',
      readyCutsOnly: 'true',
      payment: 'any_paid',
    })).toEqual({
      page: 1,
      pageSize: 20,
      orderIds: [5, 7],
      orderDates: { values: ['2026-10-01'], includeEmpty: true },
      sheetMaterialTypeIds: { values: [], includeEmpty: true },
      filmIds: { values: [3, 4], includeEmpty: false },
      supplierKeys: ['s:12', 'c:9b2f-11aa', 'n:0cc175b9c0f1b6a831c399e269772661', 'none'],
      readyCutsOnly: true,
      payment: 'any_paid',
    });
    expect(parseOrderResourceDemandQuery({ payment: 'fully_paid', readyCutsOnly: 'false', orderIds: '' })).toEqual({
      page: 1, pageSize: 20, payment: 'fully_paid',
    });
  });

  it('a leading «!» means «all except» for dates, materials, films and suppliers', () => {
    expect(parseOrderResourceDemandQuery({ filmIds: '!3,none', orderDates: '!', supplierKeys: '!s:2' })).toEqual({
      page: 1,
      pageSize: 20,
      filmIds: { values: [3], includeEmpty: false, exclude: true },
      orderDates: { values: [], includeEmpty: true, exclude: true },
      supplierKeys: ['s:2'],
      supplierKeysExclude: true,
    });
    expect(() => parseOrderResourceDemandQuery({ orderIds: '!5' })).toThrow(ApiError);
  });

  it.each([
    [{ orderIds: '1,x' }, 'orderIds'],
    [{ orderIds: '1,,2' }, 'orderIds'],
    [{ orderDates: '2026-02-30' }, 'orderDates'],
    [{ filmIds: '0' }, 'filmIds'],
    [{ supplierKeys: 's:abc' }, 'supplierKeys'],
    [{ supplierKeys: "c:x';--" }, 'supplierKeys'],
    [{ payment: 'paid' }, 'payment'],
    [{ readyCutsOnly: 'yes' }, 'readyCutsOnly'],
    [{ orderIds: Array.from({ length: 501 }, (_, index) => index + 1).join(',') }, 'orderIds'],
  ])('rejects an invalid header filter %j', (raw, field) => {
    expect(() => parseOrderResourceDemandQuery(raw)).toThrow(ApiError);
    try {
      parseOrderResourceDemandQuery(raw);
    } catch (error) {
      expect((error as ApiError).code).toBe('ORDER_RESOURCE_DEMAND_QUERY_INVALID');
      expect(JSON.stringify((error as ApiError).details)).toContain(field);
    }
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
