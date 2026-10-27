import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, normalizeClientScreenCodes } from './client-screen.registry';

const migration = readFileSync(new URL('../../../db/migrations/241_client_screen_settings.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
const contract = load(readFileSync(new URL('../../../contracts/04-api-contract.openapi.yaml', import.meta.url), 'utf8')) as Record<string, any>;

describe('client screen registry', () => {
  it('lists every code once, and every field belongs to a tab of the registry or to the summary', () => {
    expect(new Set(CLIENT_SCREEN_CODES).size).toBe(CLIENT_SCREEN_CODES.length);
    const tabs = CLIENT_SCREEN_CODES.filter((code) => code.startsWith('tab.')).map((code) => code.slice(4));
    for (const code of CLIENT_SCREEN_CODES) {
      expect(code).toMatch(/^[a-z_]+\.[a-z_]+$/);
      const group = code.split('.')[0];
      if (group !== 'tab' && group !== 'summary') expect(tabs).toContain(group);
    }
  });

  it('defaults are registry codes in registry order, and a default field has its tab switched on', () => {
    expect(normalizeClientScreenCodes(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES)).toEqual(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES);
    for (const code of CLIENT_SCREEN_DEFAULT_VISIBLE_CODES) {
      const group = code.split('.')[0];
      if (group !== 'tab' && group !== 'summary') expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES).toContain(`tab.${group}`);
    }
  });

  it('normalizes to known codes without repeats in registry order', () => {
    expect(normalizeClientScreenCodes(['details.name', 'tab.basic', 'no.such', 'details.name', 'summary.number']))
      .toEqual(['summary.number', 'tab.basic', 'details.name']);
    expect(normalizeClientScreenCodes([])).toEqual([]);
  });

  it('the migration seeds exactly the default codes with the screen switched off, additively', () => {
    const seed = migration.slice(migration.indexOf('ARRAY['), migration.indexOf(']::text[]'));
    expect([...seed.matchAll(/'([a-z_.]+)'/g)].map((match) => match[1])).toEqual(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES);
    expect(migration).toContain('VALUES (1, false, ARRAY[');
    expect(migration).toContain('ON CONFLICT (config_id) DO NOTHING');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.client_screen_settings');
    expect(migration).not.toMatch(/^\s*(DROP|ALTER|UPDATE|DELETE)\b/m);
  });

  it('the migration runner probes the table, its checks and the singleton row before recording the ledger', () => {
    expect(runner).toContain('241_client_screen_settings*) probe_all');
    for (const probe of ['q_tbl client_screen_settings', 'q_col client_screen_settings enabled', 'q_col client_screen_settings visible_codes',
      'q_con_on client_screen_settings chk_client_screen_settings_singleton', 'q_con_on client_screen_settings chk_client_screen_settings_codes',
      'SELECT EXISTS (SELECT 1 FROM client_screen_settings WHERE config_id = 1);']) expect(runner).toContain(probe);
    expect(runner.slice(runner.indexOf('verify_applied_effect() {'))).toContain('241_client_screen_settings*');
  });

  it('the OpenAPI contract lists the same codes and the documented permissions', () => {
    expect(contract.components.schemas.ClientScreenCode.enum).toEqual([...CLIENT_SCREEN_CODES]);
    const path = contract.paths['/api/v1/client-screen/settings'];
    expect(path.get['x-permissions-any']).toEqual(['orders.view', 'settings.manage']);
    expect(path.get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/ClientScreenSettings');
    expect(contract.components.schemas.ClientScreenSettings.required).toEqual(['enabled', 'visibleCodes', 'version', 'updatedAt']);
    const updated = path.put.responses['200'].content['application/json'].schema.allOf;
    expect(updated[0].$ref).toBe('#/components/schemas/ClientScreenSettings');
    expect(updated[1].required).toEqual(['changed']);
    expect(path.put['x-permission']).toBe('settings.manage');
    const body = path.put.requestBody.content['application/json'].schema;
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(['enabled', 'visibleCodes', 'expectedVersion']);
    expect(body.properties.visibleCodes.items.$ref).toBe('#/components/schemas/ClientScreenCode');
  });
});
