import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./httpClient', () => ({ httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
import { httpClient } from './httpClient';
import { sheetMaterialsApi } from './sheetMaterialsApi';

beforeEach(() => vi.clearAllMocks());

describe('sheetMaterialsApi', () => {
  it('create POSTs to /api/v1/sheet-material-types', async () => {
    (httpClient.post as any).mockResolvedValue({ sheetMaterialTypeId: 1 });
    await sheetMaterialsApi.create({ name: 'X', materialTypeId: 1, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070 });
    expect(httpClient.post).toHaveBeenCalledWith('/api/v1/sheet-material-types', expect.objectContaining({ name: 'X' }));
  });

  it('update PUTs with version in body', async () => {
    (httpClient.put as any).mockResolvedValue({});
    await sheetMaterialsApi.update(5, { name: 'X', materialTypeId: 1, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070 }, 3);
    expect(httpClient.put).toHaveBeenCalledWith('/api/v1/sheet-material-types/5', expect.objectContaining({ name: 'X', version: 3 }));
  });

  it('deactivate DELETEs with version body', async () => {
    (httpClient.delete as any).mockResolvedValue(undefined);
    await sheetMaterialsApi.deactivate(5, 3);
    expect(httpClient.delete).toHaveBeenCalledWith('/api/v1/sheet-material-types/5', expect.objectContaining({ body: JSON.stringify({ version: 3 }) }));
  });
});
