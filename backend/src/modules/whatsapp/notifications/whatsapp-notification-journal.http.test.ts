import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorFilter } from '../../../common/errors/api-error.filter';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { WhatsAppPermissionsGuard } from '../whatsapp-permissions.guard';
import { WhatsAppNotificationJournalController } from './whatsapp-notification-journal.controller';
import { WhatsAppNotificationJournalService } from './whatsapp-notification-journal.service';

// The real controller and WhatsAppPermissionsGuard behind real Nest + Express; the user comes from a test header
// (in the app — the auth middleware), the journal and the database are stubs.
const USERS: Record<string, Partial<CurrentUser>> = {
  admin: { id: 7, username: 'wa-admin', role: 'admin' as never, permissions: ['whatsapp.manage', 'onec.view'] as never },
  viewer: { id: 8, username: 'wa-viewer', role: 'manager' as never, permissions: ['whatsapp.view'] as never },
};
const auditWrites: Array<{ sql: string; params: readonly unknown[] }> = [];
const listCalls: Array<{ query: unknown; viewer: unknown }> = [];

class JournalHttpTestModule {}
Module({
  controllers: [WhatsAppNotificationJournalController],
  providers: [
    WhatsAppPermissionsGuard,
    { provide: PermissionsService, useValue: { canUser: (user: CurrentUser, permission: string) => Boolean(user?.permissions.includes(permission as never)) } },
    { provide: DatabaseService, useValue: { query: async (sql: string, params: readonly unknown[] = []) => { auditWrites.push({ sql, params }); return { rows: [], rowCount: 1 }; } } },
    {
      provide: WhatsAppNotificationJournalService,
      useValue: {
        channel: async () => ({ enabled: false }),
        list: async (query: unknown, viewer: unknown) => { listCalls.push({ query, viewer }); return { data: [], pagination: { page: 1, pageSize: 50, total: 0, totalCapped: false } }; },
      },
    },
  ],
})(JournalHttpTestModule);

describe('WhatsApp notification journal HTTP (real controller and permissions guard)', () => {
  let app: INestApplication;
  let url = '';

  beforeAll(async () => {
    app = await NestFactory.create(JournalHttpTestModule, { logger: false, abortOnError: false });
    app.use((request: { headers: Record<string, string>; user?: unknown; requestId?: string }, _response: unknown, next: () => void) => {
      const user = USERS[request.headers['x-test-user'] ?? ''];
      if (user) request.user = user;
      request.requestId = 'req-journal-test';
      next();
    });
    app.useGlobalFilters(new ApiErrorFilter());
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    auditWrites.length = 0;
    listCalls.length = 0;
  });

  const get = (path: string, user?: string) => fetch(`${url}/api/v1/whatsapp/notifications/${path}`, { headers: user ? { 'x-test-user': user } : {} });

  it('requires a signed-in user', async () => {
    expect((await get('channel')).status).toBe(401);
    expect((await get('deliveries')).status).toBe(401);
    expect(listCalls).toEqual([]);
  });

  it('refuses whatsapp.view without whatsapp.manage and records the denial with actor and request id', async () => {
    for (const path of ['channel', 'deliveries']) {
      const response = await get(path, 'viewer');
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    }
    expect(listCalls).toEqual([]);
    const denied = auditWrites.filter((write) => write.params.includes('whatsapp.permission_denied'));
    expect(denied).toHaveLength(2);
    for (const write of denied) {
      expect(write.params).toContain(8);
      expect(write.params).toContain('req-journal-test');
    }
    expect(denied.map((write) => write.params.find((value) => String(value).startsWith('GET:')))).toEqual([
      'GET:/api/v1/whatsapp/notifications/channel', 'GET:/api/v1/whatsapp/notifications/deliveries']);
  });

  it('serves whatsapp.manage, passes the viewer permissions to the journal and validates the query', async () => {
    const channel = await get('channel', 'admin');
    expect(channel.status).toBe(200);
    expect(channel.headers.get('cache-control')).toBe('private, no-store');
    const list = await get('deliveries?state=sent&pageSize=20', 'admin');
    expect(list.status).toBe(200);
    expect(listCalls).toEqual([{ query: { page: 1, pageSize: 20, state: 'sent' }, viewer: { permissions: ['whatsapp.manage', 'onec.view'] } }]);
    const invalid = await get('deliveries?from=2026-02-30', 'admin');
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_WHATSAPP_NOTIFICATION_JOURNAL_QUERY' } });
  });
});
