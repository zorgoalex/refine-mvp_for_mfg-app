import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { LabelsPort, ScanCandidateRow, ScanSearchInput } from './labels.types';
import { LabelsService } from './labels.service';

const TPL = '{order.order_name}|{bazis.col_005}|{bazis.position_in_product}';

const manager: CurrentUser = {
  id: '10',
  username: 'manager',
  role: 'manager',
  roleId: 10,
  permissions: ['labels.view', 'labels.generate'],
};

function makeService(overrides: Partial<LabelsPort> = {}) {
  const repo: Partial<LabelsPort> = {
    listActiveQrTemplateStrings: vi.fn().mockResolvedValue([TPL]),
    findScanCandidates: vi.fn().mockResolvedValue([
      {
        detailId: 60084,
        orderId: 11380,
        orderName: 'импорт 68',
        detailNumber: 1,
        width: 50,
        height: 750,
        quantity: 1,
        materialName: 'МДФ 16мм',
        productionStatusName: 'Новый',
        matchedFields: ['order_name', 'detail_number'],
      } satisfies ScanCandidateRow,
    ]),
    recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const service = new LabelsService({ repo: repo as unknown as LabelsPort });
  return { service, repo: repo as unknown as Record<keyof LabelsPort, ReturnType<typeof vi.fn>> };
}

describe('LabelsService.scanResolve', () => {
  it('parses payload by active template and returns ranked candidates', async () => {
    const { service, repo } = makeService();
    const result = await service.scanResolve({
      currentUser: manager,
      requestId: 'req-1',
      payload: 'импорт 68|60084|1',
      source: 'qr',
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'импорт 68', detailNumber: 1 }),
    );
    expect(result.templatesTried).toBe(1);
    expect(result.parsed).toMatchObject({ 'order.order_name': 'импорт 68' });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].score).toBeGreaterThan(0);
    expect(result.candidates[0].matchedBy).toContain('qr-template');
  });

  it('falls back to manual interpretation when no template matches', async () => {
    const { service, repo } = makeService({
      listActiveQrTemplateStrings: vi.fn().mockResolvedValue([TPL]),
    });
    await service.scanResolve({
      currentUser: manager,
      requestId: 'req-2',
      payload: 'импорт 68',
      source: 'manual',
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'импорт 68' }),
    );
  });

  it('rejects empty payload with 422', async () => {
    const { service } = makeService();
    await expect(
      service.scanResolve({ currentUser: manager, requestId: 'r', payload: '   ', source: 'qr' }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('order name containing the separator: right parse queried AND winning parse returned', async () => {
    // Имя заказа 'A|B'. Лево-якорный парс даёт ложное orderName='A';
    // право-якорный — 'A|B'; fallback — целую строку. Кандидата возвращает
    // ТОЛЬКО право-якорная интерпретация → result.parsed обязан быть её парсом.
    const calls: ScanSearchInput[] = [];
    const candidate: ScanCandidateRow = {
      detailId: 60084,
      orderId: 11380,
      orderName: 'A|B',
      detailNumber: 1,
      width: 50,
      height: 750,
      quantity: 1,
      materialName: 'МДФ 16мм',
      productionStatusName: 'Новый',
      matchedFields: ['order_name', 'detail_number'],
    };
    const { service } = makeService({
      findScanCandidates: vi.fn().mockImplementation(async (input: ScanSearchInput) => {
        calls.push(input);
        return input.orderName === 'A|B' ? [candidate] : [];
      }),
    });
    const result = await service.scanResolve({
      currentUser: manager,
      requestId: 'req-3',
      payload: 'A|B|60084|1',
      source: 'qr',
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderName: 'A' }), // лево-якорная (ложная) тоже опрошена
        expect.objectContaining({ orderName: 'A|B' }), // право-якорная
        expect.objectContaining({ orderName: 'A|B|60084|1' }), // fallback целой строкой
      ]),
    );
    expect(result.candidates).toHaveLength(1);
    // parsed = парс ПОБЕДИВШЕЙ интерпретации (право-якорной), не первой попавшейся:
    expect(result.parsed).toMatchObject({ 'order.order_name': 'A|B' });
    // parsed не протекает внутрь кандидатов:
    expect(result.candidates[0]).not.toHaveProperty('parsed');
  });
});
