import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cncTelegramImportApi, normalizePrepared } from './cncTelegramImportApi';

const scanId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-4333-8333-333333333333';

describe('cncTelegramImportApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates bounded scan request with idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ scanId, status: 'pending' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await cncTelegramImportApi.createScan({ dateFrom: '2026-08-17', dateTo: '2026-08-19' }, 'scan:key');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cnc-telegram/import-scans');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('scan:key');
  });

  it('normalizes backend {items,total} candidate response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await cncTelegramImportApi.listCandidates(scanId);
    expect(result).toMatchObject({ scanId, candidates: [], pagination: { total: 0, totalPages: 0 } });
  });

  it('sends explicit duplicate acknowledgements on confirm', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ importRequestId: requestId, items: [] }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await cncTelegramImportApi.confirm(requestId, {
      confirmationId: requestId,
      duplicateAcknowledgements: [{ candidateId, duplicateAcknowledged: true }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      confirmationId: requestId,
      duplicateAcknowledgements: [{ candidateId, duplicateAcknowledged: true }],
    });
  });

  it('rejects duplicate candidate IDs before network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => cncTelegramImportApi.prepare(scanId, { candidateIds: [candidateId, candidateId] }, 'prepare:key')).toThrow('Invalid candidateIds');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes the backend request response returned by prepare', () => {
    const result = normalizePrepared({
      importRequestId: requestId,
      scanId,
      requestedBy: 'user-1',
      status: 'draft',
      confirmationId: requestId,
      repeatOfImportRequestId: null,
      totalCount: 1,
      importedCount: 0,
      failedCount: 0,
      items: [{
        importItemId: '44444444-4444-4444-8444-444444444444',
        candidateId,
        status: 'pending',
        duplicateAcknowledged: false,
        matches: [{ kind: 'same_telegram_source', packetId: null, cutJobId: 42, cutResultId: null }],
        cutJobId: null,
        cutJobDisplayNumber: null,
        packetId: null,
      }],
      error: null,
      selectionHash: 'selection-hash',
    } as never);

    expect(result).toMatchObject({
      importRequestId: requestId,
      status: 'draft',
      duplicateCount: 1,
      candidates: [],
      refreshedMatches: { [candidateId]: [{ kind: 'same_telegram_source', packetId: null, cutJobId: 42, cutResultId: null }] },
    });
  });
});
