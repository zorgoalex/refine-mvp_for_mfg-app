import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InventoryOnecAutosyncService } from './inventory-onec-autosync.service';

// Границы фоновых запусков (code review R1): ошибка БД в часовом проходе или после сигнала
// только логируется — необработанный rejection завершил бы backend (Node 20).
const config = { get: (key: string) => ({ BACKEND_INVENTORY_ONEC_AUTOSYNC: true, BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID: 5 } as Record<string, unknown>)[key] };
const inventory = { enabled: () => true };

function make(database: { query: ReturnType<typeof vi.fn>; transaction?: ReturnType<typeof vi.fn> }, reader: { warehouseSourceIds: ReturnType<typeof vi.fn> }) {
  return new InventoryOnecAutosyncService(database as never, config as never, inventory as never, reader as never, {} as never, {} as never);
}

describe('InventoryOnecAutosyncService background boundaries', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a failing source listing never rejects the timer pass', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = make({ query: vi.fn() }, { warehouseSourceIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(service.safeHourlyPass()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('a failure of one source (sequence allocation) does not stop the others and never rejects', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const query = vi.fn().mockRejectedValue(new Error('connection terminated'));
    const service = make({ query }, { warehouseSourceIds: vi.fn().mockResolvedValue([1, 2]) });
    await expect(service.safeHourlyPass()).resolves.toBeUndefined();
    // Both sources were attempted (one allocation query each).
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map((call) => call[1])).toEqual([[1], [2]]);
  });

  it('a failure while recording the error outcome after a signal is logged, not thrown', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ last_seq: '1' }] }) // allocate seq
      .mockRejectedValueOnce(new Error('actor lookup failed')); // readyActor
    const transaction = vi.fn().mockRejectedValue(new Error('write failed'));
    const service = make({ query, transaction }, { warehouseSourceIds: vi.fn().mockResolvedValue([1]) });
    const onPublished = (service as unknown as { onPublished(event: unknown): Promise<void> }).onPublished.bind(service);
    await expect(onPublished({ sourceId: 1, runId: 'r', requestId: 'q', correlationId: 'c' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('write failed'));
  });
});
