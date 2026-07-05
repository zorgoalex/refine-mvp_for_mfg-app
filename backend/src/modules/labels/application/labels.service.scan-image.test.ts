import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { LabelsPort, OcrPort, ScanCandidateRow } from './labels.types';
import { LabelsService } from './labels.service';

const manager: CurrentUser = {
  id: '10',
  username: 'manager',
  role: 'manager',
  roleId: 10,
  permissions: ['labels.view', 'labels.generate'],
};

function makeService(overrides: { repo?: Partial<LabelsPort>; ocr?: Partial<OcrPort> } = {}) {
  const repo: Partial<LabelsPort> = {
    recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
    findScanCandidates: vi.fn().mockResolvedValue([]),
    listActiveOcrTemplatesForMatch: vi.fn().mockResolvedValue([]),
    ...overrides.repo,
  };
  const ocr: Partial<OcrPort> = {
    recognize: vi.fn().mockResolvedValue({ lines: [], durationMs: 0 }),
    ...overrides.ocr,
  };
  const service = new LabelsService({ repo: repo as LabelsPort, ocr: ocr as OcrPort });
  return {
    service,
    repo: repo as unknown as Record<keyof LabelsPort, ReturnType<typeof vi.fn>>,
    ocr: ocr as unknown as Record<keyof OcrPort, ReturnType<typeof vi.fn>>,
  };
}

const liveCandidate: ScanCandidateRow = {
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
};

const staleSnapshotCandidate: ScanCandidateRow = {
  detailId: 70099,
  orderId: 22990,
  orderName: 'чужой заказ',
  detailNumber: 1,
  width: 50,
  height: 750,
  quantity: 1,
  materialName: 'МДФ 16мм',
  productionStatusName: 'Готово',
  matchedFields: ['snapshot', 'detail_number'],
};

describe('LabelsService.scanResolveFields', () => {
  it('rejects when caller lacks labels.view', async () => {
    const { service } = makeService();
    await expect(
      service.scanResolveFields({
        currentUser: { ...manager, permissions: [] },
        requestId: 'req-1',
        fields: { orderName: 'импорт 68' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('maps orderName + detailNumber to ScanSearchInput and includes bazisFields ONLY when both are present', async () => {
    const { service, repo } = makeService();
    await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-2',
      fields: { orderName: 'импорт 68', detailNumber: 1 },
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith({
      orderName: 'импорт 68',
      detailNumber: 1,
      bazisFields: {
        'bazis.order_number': 'импорт 68',
        'bazis.position_in_product': '1',
      },
    });
  });

  it('does NOT build bazisFields when only orderName was extracted', async () => {
    const { service, repo } = makeService();
    await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-3',
      fields: { orderName: 'импорт 68' },
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith({ orderName: 'импорт 68' });
  });

  it('does NOT build bazisFields when only detailNumber was extracted', async () => {
    const { service, repo } = makeService();
    await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-4',
      fields: { detailNumber: 1 },
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith({ detailNumber: 1 });
  });

  it('returns empty result WITHOUT calling the repo when no searchable fields were extracted', async () => {
    const { service, repo } = makeService();
    const result = await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-5',
      fields: { material: 'МДФ 16мм' },
    });
    expect(repo.findScanCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: [], parsed: { material: 'МДФ 16мм' }, templatesTried: 0 });
  });

  it('retags snapshot -> snapshot_pair for candidates found via bazisFields (this flow only)', async () => {
    const { service, repo } = makeService({
      repo: { findScanCandidates: vi.fn().mockResolvedValue([staleSnapshotCandidate]) },
    });
    const result = await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-6',
      fields: { orderName: 'чужой заказ', detailNumber: 1 },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toEqual(['snapshot_pair', 'detail_number']);
    expect(result.candidates[0].matchedBy).toBe('ocr-fields');
    // snapshot_pair(4) + detail_number(3) = 7, above the minScore(3) floor but present.
    expect(result.candidates[0].score).toBe(7);
  });

  it('live order with matching name (8) outranks a different order´s stale snapshot (7) — live wins', async () => {
    const { service } = makeService({
      repo: { findScanCandidates: vi.fn().mockResolvedValue([staleSnapshotCandidate, liveCandidate]) },
    });
    const result = await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-7',
      fields: { orderName: 'импорт 68', detailNumber: 1 },
    });
    expect(result.candidates.map((c) => c.detailId)).toEqual([liveCandidate.detailId, staleSnapshotCandidate.detailId]);
    expect(result.candidates[0].score).toBe(8); // order_name(5) + detail_number(3)
    expect(result.candidates[1].score).toBe(7); // snapshot_pair(4) + detail_number(3)
  });

  it('parsed stringifies numeric fields and drops absent ones', async () => {
    const { service } = makeService();
    const result = await service.scanResolveFields({
      currentUser: manager,
      requestId: 'req-8',
      fields: { orderName: 'импорт 68', detailNumber: 1, width: 500, height: 300 },
    });
    expect(result.parsed).toEqual({
      orderName: 'импорт 68',
      detailNumber: '1',
      width: '500',
      height: '300',
    });
  });
});

describe('LabelsService.scanResolveImage', () => {
  it('rejects when caller lacks labels.view (checked before OCR call)', async () => {
    const { service, ocr } = makeService();
    await expect(
      service.scanResolveImage({
        currentUser: { ...manager, permissions: [] },
        requestId: 'req-1',
        image: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('fails closed 503 when no OcrPort is configured', async () => {
    const service = new LabelsService({ repo: { recordPermissionDenied: vi.fn(), findScanCandidates: vi.fn() } as unknown as LabelsPort });
    await expect(
      service.scanResolveImage({ currentUser: manager, requestId: 'req-2', image: Buffer.from('x'), contentType: 'image/png' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OCR_SERVICE_UNAVAILABLE' });
  });

  it('propagates OcrPort 503 errors as-is', async () => {
    const { ApiError } = await import('../../../common/errors/api-error');
    const { service } = makeService({
      ocr: { recognize: vi.fn().mockRejectedValue(new ApiError(503, 'OCR_SERVICE_BUSY', 'OCR service is busy')) },
    });
    await expect(
      service.scanResolveImage({ currentUser: manager, requestId: 'req-3', image: Buffer.from('x'), contentType: 'image/png' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OCR_SERVICE_BUSY' });
  });

  it('no extractable fields -> empty result WITHOUT calling the repo, ocr block still populated', async () => {
    const { service, repo, ocr } = makeService({
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [{ text: 'какой-то нечитаемый мусор', score: 0.4 }],
          durationMs: 42,
        }),
      },
    });
    const result = await service.scanResolveImage({
      currentUser: manager,
      requestId: 'req-4',
      image: Buffer.from('x'),
      contentType: 'image/png',
    });
    expect(repo.findScanCandidates).not.toHaveBeenCalled();
    expect(ocr.recognize).toHaveBeenCalledWith(Buffer.from('x'), 'image/png');
    expect(result).toEqual({
      candidates: [],
      parsed: null,
      templatesTried: 0,
      ocr: { lineCount: 1, durationMs: 42 },
    });
  });

  it('extracts fields from OCR lines, resolves via scanResolveFields, and attaches the ocr block', async () => {
    const { service, repo } = makeService({
      repo: { findScanCandidates: vi.fn().mockResolvedValue([liveCandidate]) },
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [
            { text: 'Заказ№: импорт 68 Поз.1', score: 0.9 },
            { text: '500х300 МДФ 16мм', score: 0.8 },
          ],
          durationMs: 123,
        }),
      },
    });
    const result = await service.scanResolveImage({
      currentUser: manager,
      requestId: 'req-5',
      image: Buffer.from('x'),
      contentType: 'image/jpeg',
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'импорт 68', detailNumber: 1 }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedBy).toBe('ocr-fields');
    expect(result.ocr).toEqual({ lineCount: 2, durationMs: 123 });
  });

  it('an active OCR template match drives field extraction (over the legacy fallback parser)', async () => {
    const { service, repo } = makeService({
      repo: {
        findScanCandidates: vi.fn().mockResolvedValue([liveCandidate]),
        listActiveOcrTemplatesForMatch: vi.fn().mockResolvedValue([
          {
            id: 7,
            name: 'Реализация',
            rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
          },
        ]),
      },
      ocr: {
        // These lines would NOT extract via the legacy extractLabelFields() fallback
        // (no "Заказ№:"/"Поз" markers) but DO match the configured template's rules.
        recognize: vi.fn().mockResolvedValue({
          lines: [
            { text: '11380', score: 0.95 },
            { text: 'лДСп Дуб Гарден 16мм', score: 0.85 },
            { text: '649 X 238', score: 0.9 },
          ],
          durationMs: 66,
        }),
      },
    });
    const result = await service.scanResolveImage({
      currentUser: manager,
      requestId: 'req-6',
      image: Buffer.from('x'),
      contentType: 'image/png',
    });
    // Template-derived orderName came from the order_number rule ('11380').
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: '11380' }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.ocr).toEqual({ lineCount: 3, durationMs: 66 });
  });

  it('no active templates -> falls back to extractLabelFields (existing behaviour unchanged)', async () => {
    const { service, repo } = makeService({
      repo: {
        findScanCandidates: vi.fn().mockResolvedValue([liveCandidate]),
        listActiveOcrTemplatesForMatch: vi.fn().mockResolvedValue([]),
      },
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [
            { text: 'Заказ№: импорт 68 Поз.1', score: 0.9 },
            { text: '500х300 МДФ 16мм', score: 0.8 },
          ],
          durationMs: 123,
        }),
      },
    });
    const result = await service.scanResolveImage({
      currentUser: manager,
      requestId: 'req-7',
      image: Buffer.from('x'),
      contentType: 'image/jpeg',
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'импорт 68', detailNumber: 1 }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.ocr).toEqual({ lineCount: 2, durationMs: 123 });
  });

  it('active templates present but none match (matcher miss) -> falls back to extractLabelFields', async () => {
    const { service, repo } = makeService({
      repo: {
        findScanCandidates: vi.fn().mockResolvedValue([liveCandidate]),
        listActiveOcrTemplatesForMatch: vi.fn().mockResolvedValue([
          {
            id: 9,
            name: 'Другой формат',
            rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
          },
        ]),
      },
      ocr: {
        // Only one recognizable line -> can't satisfy the template's 2-strong-field threshold,
        // matchOcrTemplates returns null, so extractLabelFields legacy parsing takes over.
        recognize: vi.fn().mockResolvedValue({
          lines: [{ text: 'Заказ№: импорт 68 Поз.1', score: 0.9 }],
          durationMs: 12,
        }),
      },
    });
    const result = await service.scanResolveImage({
      currentUser: manager,
      requestId: 'req-8',
      image: Buffer.from('x'),
      contentType: 'image/png',
    });
    expect(repo.findScanCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'импорт 68', detailNumber: 1 }),
    );
    expect(result.candidates).toHaveLength(1);
  });
});
