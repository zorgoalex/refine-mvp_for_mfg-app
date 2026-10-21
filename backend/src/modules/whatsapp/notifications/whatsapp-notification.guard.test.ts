import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WHATSAPP_NOTIFICATION_SOURCE_READ_PERMISSIONS, journalVisibilitySql } from './whatsapp-notification-journal.service';
import { WHATSAPP_NOTIFICATION_SOURCE_ENTITY_TYPES } from './whatsapp-notification.types';

const WHATSAPP = resolve(__dirname, '..');
const MODULES = resolve(WHATSAPP, '..');

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Module directories imported (transitively, by relative paths) from the WhatsApp module's own sources. */
function importedModules(): Set<string> {
  const seen = new Set<string>();
  const modules = new Set<string>();
  const queue = sources(WHATSAPP);
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), spec);
      const rel = relative(MODULES, target);
      if (!rel.startsWith('..')) modules.add(rel.split('/')[0]);
      for (const candidate of [`${target}.ts`, join(target, 'index.ts')]) {
        try { if (statSync(candidate).isFile()) queue.push(candidate); } catch { /* not this form */ }
      }
    }
  }
  return modules;
}

describe('WhatsApp notification channel boundaries', () => {
  it('the WhatsApp module never imports 1C modules (the 1C monitor imports WhatsAppModule for the port)', () => {
    expect([...importedModules()].filter((name) => /^onec/.test(name))).toEqual([]);
  });

  it('exports the port and starts the delivery epoch in onModuleInit without calling WAHA', () => {
    expect(readFileSync(join(WHATSAPP, 'whatsapp.module.ts'), 'utf8')).toContain('exports: [WhatsAppNotificationPort]');
    const worker = readFileSync(join(__dirname, 'whatsapp-notification-worker.service.ts'), 'utf8');
    const init = worker.slice(worker.indexOf('async onModuleInit()'), worker.indexOf('onModuleDestroy()'));
    expect(init).toContain('await this.ensureEpoch()');
    expect(init).not.toMatch(/waha|whatsapp\./i);
    // ensureEpoch never throws: its failure is logged and retried on the next tick.
    const ensure = worker.slice(worker.indexOf('async ensureEpoch()'), worker.indexOf('private deliverable()'));
    expect(ensure).toMatch(/try \{[\s\S]*\} catch/);
  });

  it('the journal endpoints are behind the WhatsApp permissions guard with whatsapp.manage, rows behind their source permission', () => {
    // Decorated sources cannot be imported here; the live check of 401/403/200 and the denial audit is the stage smoke.
    const controller = readFileSync(join(__dirname, 'whatsapp-notification-journal.controller.ts'), 'utf8');
    expect(controller).toContain("@Controller('whatsapp/notifications')\n@UseGuards(WhatsAppPermissionsGuard)");
    expect(controller.match(/@Get\('[a-z]+'\) @ApiBearerAuth\('bearerAuth'\) @RequirePermissions\('whatsapp\.manage'\)/g)).toHaveLength(2);
    expect(controller.match(/@Get\(/g)).toHaveLength(2);
    expect(controller).toContain('this.journal.list(parseWhatsAppNotificationJournalQuery(query), { permissions: request.user.permissions })');
    expect(readFileSync(join(WHATSAPP, 'whatsapp.module.ts'), 'utf8')).toMatch(/controllers: \[[^\]]*WhatsAppNotificationJournalController\]/);
  });

  it('a journal row needs a readable source and its own required permission', () => {
    const params: unknown[] = [];
    const sql = journalVisibilitySql({ permissions: ['whatsapp.manage'] }, params);
    expect(sql).toContain('d.source_type = ANY($1::text[])');
    expect(sql).toContain('d.required_permission IS NULL OR d.required_permission = ANY($2::text[])');
    expect(params).toEqual([[], ['whatsapp.manage']]);
    const allowed: unknown[] = [];
    journalVisibilitySql({ permissions: ['whatsapp.manage', 'onec.view'] }, allowed);
    expect(allowed[0]).toEqual(['onec_alert']);
    expect(WHATSAPP_NOTIFICATION_SOURCE_READ_PERMISSIONS).toEqual({ onec_alert: 'onec.view' });
  });

  it('every source is registered in both registries: read permission and audit relation', () => {
    // A source missing from the entity registry would silently lose its audit relation.
    expect(Object.keys(WHATSAPP_NOTIFICATION_SOURCE_ENTITY_TYPES).sort()).toEqual(Object.keys(WHATSAPP_NOTIFICATION_SOURCE_READ_PERMISSIONS).sort());
  });
});
