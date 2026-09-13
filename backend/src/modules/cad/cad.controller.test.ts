import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { CadController } from './cad.controller';
import type { CadService } from './cad.service';

const req = { user: { id: '1', permissions: ['cad.view'] } } as RequestWithCurrentUser;
it('accepts5000 saved instances, rejects5001 and keeps source/preview limits', () => {
  const save = vi.fn(), preview = vi.fn(), controller = new CadController({ save, preview } as unknown as CadService);
  const sourceId = randomUUID(), variantId = randomUUID();
  const groups = Array.from({ length: 5000 }, () => ({ id: randomUUID(), sourceSnapshotId: sourceId, orderId: 1, detailId: 1,
    quantity: 1, recipe: null, xMm: 0, yMm: 0, rotationDeg: 0 }));
  controller.save(req, variantId, 'key', { version: 1, groups, sourceIds: [sourceId] });
  expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][3]).toHaveLength(5000);
  expect(() => controller.save(req, variantId, 'key', { version: 1, groups: [...groups, groups[0]], sourceIds: [sourceId] })).toThrow();
  expect(() => controller.save(req, variantId, 'key', { version: 1, groups: groups.slice(0, 1), sourceIds: Array.from({ length: 501 }, () => randomUUID()) })).toThrow();
  expect(() => controller.preview(req, variantId, { version: 1, groups: groups.slice(0, 21) })).toThrow();
  expect(save).toHaveBeenCalledTimes(1); expect(preview).not.toHaveBeenCalled();
});
it('gates new frontend on every bounded API capability', async () => {
  const remote = { editor_version: 2, max_parts: 5000, bounded_runs: true, file_pages: true, readiness_pages: true };
  const capabilities = vi.fn().mockResolvedValue(remote);
  const controller = new CadController({ enabled: true, editorEnabled: true, require: vi.fn(), client: { capabilities } } as unknown as CadService);
  expect((await controller.capabilities(req)).independentInstances).toBe(true);
  for (const missing of ['bounded_runs', 'file_pages', 'readiness_pages']) {
    capabilities.mockResolvedValue({ ...remote, [missing]: false });
    expect((await controller.capabilities(req)).independentInstances).toBe(false);
  }
});
