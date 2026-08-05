import { describe, expect, it, vi } from 'vitest';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { BazisCutSetsController } from './bazis-cut-sets.controller';

describe('BazisCutSetsController runtime guard', () => {
  it('returns picker search with the documented 200 status', () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      BazisCutSetsController.prototype.pickerSearch,
    )).toBe(200);
  });

  it.each([
    ['list', (controller: BazisCutSetsController) => controller.list({} as never, {})],
    ['pickerFacets', (controller: BazisCutSetsController) => controller.pickerFacets({} as never, {})],
    ['pickerSearch', (controller: BazisCutSetsController) => controller.pickerSearch({} as never, null)],
    ['createFromPicker', (controller: BazisCutSetsController) => controller.createFromPicker({} as never, undefined, null)],
    ['orderMemberships', (controller: BazisCutSetsController) => controller.orderMemberships({} as never, {})],
    ['create', (controller: BazisCutSetsController) => controller.create({} as never, undefined, null)],
    ['get', (controller: BazisCutSetsController) => controller.get({} as never, '1')],
    ['rename', (controller: BazisCutSetsController) => controller.rename({} as never, '1', undefined, null)],
    ['addDetails', (controller: BazisCutSetsController) => controller.addDetails({} as never, '1', undefined, null)],
    ['updateDetail', (controller: BazisCutSetsController) => controller.updateDetail({} as never, '1', '2', undefined, null)],
    ['deleteDetail', (controller: BazisCutSetsController) => controller.deleteDetail({} as never, '1', '2', undefined, null)],
    ['export', (controller: BazisCutSetsController) => controller.export({} as never, '1', {} as never)],
  ])('%s returns 503 before service/DB work when OFF', async (_name, invoke) => {
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), rename: vi.fn(), addDetails: vi.fn(),
      pickerFacets: vi.fn(), pickerSearch: vi.fn(), createFromPicker: vi.fn(), orderMemberships: vi.fn(),
      updateDetail: vi.fn(), deleteDetail: vi.fn(), export: vi.fn(),
    };
    const controller = new BazisCutSetsController(service as never, { isEnabled: () => false } as never);

    await expect(Promise.resolve().then(() => invoke(controller))).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(Object.values(service).every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });
});
