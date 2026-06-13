import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from './httpClient';
import { orgApi } from './orgApi';

vi.mock('./httpClient', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const mocked = httpClient as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('orgApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists directions via GET /api/v1/org/directions', async () => {
    mocked.get.mockResolvedValue({ directions: [], requestId: 'r' });
    await orgApi.listDirections();
    expect(mocked.get).toHaveBeenCalledWith('/api/v1/org/directions');
  });

  it('creates a direction via POST', async () => {
    mocked.post.mockResolvedValue({ directionId: 1 });
    await orgApi.createDirection({ name: 'Покраска' });
    expect(mocked.post).toHaveBeenCalledWith('/api/v1/org/directions', { name: 'Покраска' });
  });

  it('replaces direction heads via PUT with idempotencyKey + ids', async () => {
    mocked.put.mockResolvedValue({ directionId: 1 });
    await orgApi.replaceDirectionHeads(1, { idempotencyKey: 'k1', ids: [10, 11] });
    expect(mocked.put).toHaveBeenCalledWith('/api/v1/org/directions/1/heads', {
      idempotencyKey: 'k1',
      ids: [10, 11],
    });
  });

  it('hard-deletes a direction with confirm=true', async () => {
    mocked.delete.mockResolvedValue({ directionId: 1 });
    await orgApi.deleteDirection(1);
    expect(mocked.delete).toHaveBeenCalledWith('/api/v1/org/directions/1?confirm=true');
  });

  it('fetches assignable users via GET', async () => {
    mocked.get.mockResolvedValue({ users: [], requestId: 'r' });
    await orgApi.getAssignableUsers();
    expect(mocked.get).toHaveBeenCalledWith('/api/v1/org/lookups/assignable-users');
  });
});
