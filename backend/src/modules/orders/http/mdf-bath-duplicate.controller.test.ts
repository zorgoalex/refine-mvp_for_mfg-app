import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { MdfBathDuplicateService } from '../application/mdf-bath-duplicate.service';
import {
  MdfBathDuplicateController,
  parseMdfBathCardIds,
  parseMdfBathDuplicateIdempotencyKey,
  parseResolveMdfBathDuplicateBody,
} from './mdf-bath-duplicate.controller';

vi.mock('@nestjs/common', () => ({
  Body: () => () => undefined,
  Controller: () => () => undefined,
  Get: () => () => undefined,
  Query: () => () => undefined,
  Headers: () => () => undefined,
  HttpCode: () => () => undefined,
  Inject: () => () => undefined,
  Injectable: () => () => undefined,
  Optional: () => () => undefined,
  Post: () => () => undefined,
  Req: () => () => undefined,
}));

vi.mock('@nestjs/swagger', () => ({
  ApiBearerAuth: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiHeader: () => () => undefined,
  ApiResponse: () => () => undefined,
  ApiTags: () => () => undefined,
}));

vi.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

const DIGEST = 'a'.repeat(64);
const body = { bathCardId: 'cut-result:868', otherBathCardId: 'cut-result:854', action: 'keep_both', expectedDigest: DIGEST };
const user = (permissions: string[]) => ({ id: '7', username: 'u', role: 'admin', roleId: 1, permissions });

function controller(flags: { ordersEnabled: boolean; mdfBathDuplicatesWriteEnabled?: boolean;
  mdfBathDuplicatesReadEnabled?: boolean }, resolve = vi.fn(), list = vi.fn()) {
  return {
    resolve,
    list,
    controller: new MdfBathDuplicateController(
      { resolve, list } as unknown as ConstructorParameters<typeof MdfBathDuplicateController>[0],
      { getFeatureFlags: () => flags } as unknown as ConstructorParameters<typeof MdfBathDuplicateController>[1],
    ),
  };
}

const request = (permissions: string[] = ['cut.manage', 'orders.view']) =>
  ({ user: user(permissions), requestId: 'req-1' }) as unknown as Parameters<MdfBathDuplicateController['resolve']>[0];

describe('MdfBathDuplicateController', () => {
  it('is off (503) until BACKEND_MDF_BATH_DUPLICATES_WRITE is on', () => {
    const { controller: off, resolve } = controller({ ordersEnabled: true, mdfBathDuplicatesWriteEnabled: false });
    expect(() => off.resolve(request(), body, 'key-12345678')).toThrow(expect.objectContaining({ statusCode: 503 }));
    expect(resolve).not.toHaveBeenCalled();
    const { controller: ordersOff } = controller({ ordersEnabled: false, mdfBathDuplicatesWriteEnabled: true });
    expect(() => ordersOff.resolve(request(), body, 'key-12345678')).toThrow(expect.objectContaining({ statusCode: 503 }));
  });

  it('passes the parsed body, the idempotency key and the request id', async () => {
    const { controller: on, resolve } = controller({ ordersEnabled: true, mdfBathDuplicatesWriteEnabled: true });
    await on.resolve(request(), body, 'key-12345678');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ ...body, idempotencyKey: 'key-12345678',
      requestId: 'req-1' }));
  });

  it('reads explicit baths only behind BACKEND_MDF_BATH_DUPLICATES_READ, with 1-100 bath card ids', async () => {
    const { controller: off, list: offList } = controller({ ordersEnabled: true, mdfBathDuplicatesWriteEnabled: true });
    expect(() => off.list(request(), 'cut-result:1')).toThrow(expect.objectContaining({ statusCode: 503 }));
    expect(offList).not.toHaveBeenCalled();
    const { controller: on, list } = controller({ ordersEnabled: true, mdfBathDuplicatesReadEnabled: true });
    await on.list(request(), 'cut-result:1, cut-result:2,cut-result:1');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ bathCardIds: ['cut-result:1', 'cut-result:2'] }));
    expect(parseMdfBathCardIds(Array.from({ length: 100 }, (_, i) => `cut-result:${i + 1}`).join(','))).toHaveLength(100);
    for (const bad of [undefined, '', 'packet:1', 'cut-result:0',
      Array.from({ length: 101 }, (_, i) => `cut-result:${i + 1}`).join(',')]) {
      expect(() => parseMdfBathCardIds(bad)).toThrow(ApiError);
    }
  });

  it('requires an Idempotency-Key of 8-200 safe characters', () => {
    expect(parseMdfBathDuplicateIdempotencyKey('key-12345678')).toBe('key-12345678');
    expect(() => parseMdfBathDuplicateIdempotencyKey(undefined)).toThrow(ApiError);
    expect(() => parseMdfBathDuplicateIdempotencyKey('short')).toThrow(ApiError);
    expect(() => parseMdfBathDuplicateIdempotencyKey('x'.repeat(201))).toThrow(ApiError);
    expect(() => parseMdfBathDuplicateIdempotencyKey('key with spaces')).toThrow(ApiError);
  });

  it('accepts only a strict body with two different bath cards, a known action and a digest', () => {
    expect(parseResolveMdfBathDuplicateBody(body)).toEqual(body);
    expect(parseResolveMdfBathDuplicateBody({ ...body, action: 'rework_mark' }).action).toBe('rework_mark');
    for (const bad of [
      { ...body, action: 'archive' },
      { ...body, otherBathCardId: body.bathCardId },
      { ...body, bathCardId: 'packet:1' },
      { ...body, expectedDigest: 'abc' },
      { ...body, extra: true },
    ]) {
      expect(() => parseResolveMdfBathDuplicateBody(bad)).toThrow(ApiError);
    }
  });
});

describe('MdfBathDuplicateService', () => {
  it('reads with orders.view only (403 without it)', async () => {
    const list = vi.fn(async () => ({}) as never);
    const service = new MdfBathDuplicateService({ duplicates: { resolve: vi.fn(), list } });
    await expect(service.list({ currentUser: user([]) as never, bathCardIds: ['cut-result:1'] }))
      .rejects.toMatchObject({ statusCode: 403 });
    await service.list({ currentUser: user(['orders.view']) as never, bathCardIds: ['cut-result:1'] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('requires literal cut.manage and orders.view (403) before the repository', async () => {
    const resolve = vi.fn(async () => ({}) as never);
    const service = new MdfBathDuplicateService({ duplicates: { resolve, list: vi.fn() } });
    const command = { ...body, action: 'keep_both' as const, idempotencyKey: 'key-12345678' };
    for (const permissions of [['orders.view'], ['cut.manage'], ['cut.view', 'orders.view'], []]) {
      await expect(service.resolve({ ...command, currentUser: user(permissions) as never }))
        .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    }
    expect(resolve).not.toHaveBeenCalled();
    await service.resolve({ ...command, currentUser: user(['cut.manage', 'orders.view']) as never });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
