import { describe, expect, it, vi } from 'vitest';
import {
  CatalogImportController,
  FilmReferenceController,
} from './catalog-import.controller';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { CurrentUser } from '../../../permissions/current-user';

describe('CatalogImportController contract gates', () => {
  const service = {
    create: vi.fn(),
    sources: vi.fn(),
    categories: vi.fn(),
    list: vi.fn(),
    getBatch: vi.fn(),
    rows: vi.fn(),
    matches: vi.fn(),
    patch: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    revert: vi.fn(),
    export: vi.fn(),
  };
  const runtime = { enabled: vi.fn(() => true) };
  const controller = new CatalogImportController(
    service as never,
    runtime as never
  );
  it('declares management, mirror, and film read permissions', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_METADATA_KEY,
        CatalogImportController
      )
    ).toEqual(['references.manage']);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_METADATA_KEY,
        CatalogImportController.prototype.sources
      )
    ).toEqual(['references.manage', 'onec.view']);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_METADATA_KEY,
        FilmReferenceController
      )
    ).toEqual(['references.view']);
  });
  it('returns 404 when feature flag is off', async () => {
    runtime.enabled.mockReturnValue(false);
    await expect(
      controller.list({
        user: {
          id: '1',
          username: 'a',
          role: 'admin',
          roleId: 1,
          permissions: ['references.manage'],
        },
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'CATALOG_IMPORT_NOT_FOUND',
    });
    runtime.enabled.mockReturnValue(true);
  });
  it('validates file SHA and requires onec.view for mirror source', async () => {
    const req = {
      requestId: 'r',
      user: {
        id: '1',
        username: 'a',
        role: 'admin',
        roleId: 1,
        permissions: ['references.manage'],
      },
    };
    await expect(
      controller.create(req, undefined, { kind: 'films', source: 'file' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
    await expect(
      controller.create(req, 'k', {
        kind: 'films',
        source: 'file',
        fileName: 'x.xlsx',
        sheetName: 'Пленки',
        fileSha256: 'bad',
        rows: [],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
    await expect(
      controller.create(req, 'k', {
        kind: 'films',
        source: 'onec_mirror',
        onecSourceId: 1,
        categoryKey: '3f671157-3c46-44e2-8df4-9c02a846c79a',
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'CATALOG_IMPORT_NOT_FOUND',
    });
  });
  it('requires Idempotency-Key before dispatching a valid draft command', async () => {
    const req = {
      requestId: 'r',
      user: {
        id: '1',
        username: 'a',
        role: 'admin',
        roleId: 1,
        permissions: ['references.manage'],
      },
    };
    await expect(
      controller.create(
        req,
        undefined,
        {
          kind: 'films',
          source: 'file',
          fileName: 'x.xlsx',
          sheetName: 'Пленки',
          fileSha256: 'a'.repeat(64),
          rows: [
            {
              rowNo: 2,
              nameOriginal: 'Белый снег',
              nameFull: 'Белый снег; Аиф',
              supplier: 'Аиф',
              nomenclatureType: null,
              unit: 'пог. м',
              nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
            },
          ],
        }
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('film catalog controllers — permissions are enforced, not only declared', () => {
  const guard = new PermissionsGuard(new Reflector(), new PermissionsService());
  const user = (permissions: string[]): CurrentUser => ({ id: '7', username: 'u', role: 'manager', roleId: 3, permissions } as CurrentUser);
  const context = (controller: { prototype: Record<string, unknown> }, method: string, current?: CurrentUser) => ({
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: current }) }),
  }) as never;

  it('both controllers are behind PermissionsGuard (the decorator alone is metadata)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CatalogImportController)).toEqual([PermissionsGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, FilmReferenceController)).toEqual([PermissionsGuard]);
  });

  it('import commands need references.manage: a reader or an order manager is refused before the handler runs', () => {
    for (const method of ['create', 'list', 'get', 'rows', 'matches', 'patch', 'apply', 'cancel', 'revert', 'export', 'decisions']) {
      expect(typeof CatalogImportController.prototype[method as keyof CatalogImportController], method).toBe('function');
      expect(() => guard.canActivate(context(CatalogImportController as never, method, user(['references.view', 'orders.update']))), method)
        .toThrowError(expect.objectContaining({ statusCode: 403, code: 'PERMISSION_DENIED' }));
      expect(guard.canActivate(context(CatalogImportController as never, method, user(['references.manage']))), method).toBe(true);
      expect(() => guard.canActivate(context(CatalogImportController as never, method, undefined)), method)
        .toThrowError(expect.objectContaining({ statusCode: 401 }));
    }
  });

  it('the 1C mirror lists need onec.view on top of references.manage', () => {
    for (const method of ['sources', 'categories']) {
      expect(() => guard.canActivate(context(CatalogImportController as never, method, user(['references.manage']))), method)
        .toThrowError(expect.objectContaining({ statusCode: 403 }));
      expect(guard.canActivate(context(CatalogImportController as never, method, user(['references.manage', 'onec.view']))), method).toBe(true);
    }
  });

  it('film name index, history and similar names need references.view', () => {
    for (const method of ['nameIndex', 'history', 'similar']) {
      expect(typeof FilmReferenceController.prototype[method as keyof FilmReferenceController], method).toBe('function');
      expect(() => guard.canActivate(context(FilmReferenceController as never, method, user(['orders.view']))), method)
        .toThrowError(expect.objectContaining({ statusCode: 403 }));
      expect(guard.canActivate(context(FilmReferenceController as never, method, user(['references.view']))), method).toBe(true);
    }
  });
});
