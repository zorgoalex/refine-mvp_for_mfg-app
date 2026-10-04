import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('240 payment ↔ 1C receipt matches migration', () => {
  const sql = readFileSync(new URL('./240_payment_onec_matches.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('only adds: four tables, indexes and permissions; existing tables and business data are not touched', () => {
    for (const table of ['order_onec_order_links', 'payment_onec_matches', 'payment_onec_commands', 'onec_account_payment_types']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table} (`);
    }
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
    // The only UPDATE is the permissions version bump; the only INSERTs go to the permission tables.
    expect([...sql.matchAll(/^\s*UPDATE\s+(\S+)/gim)].map((m) => m[1])).toEqual(['public.permissions_state']);
    expect([...sql.matchAll(/^INSERT INTO (\S+)/gim)].map((m) => m[1])).toEqual([
      'public.permissions_catalog', 'public.role_permissions', 'public.role_permissions',
    ]);
  });

  it('an active match keeps its payment: SET NULL on a physical delete breaks the CHECK, a removed match lets it go', () => {
    expect(sql).toContain('payment_id BIGINT NULL REFERENCES public.payments(payment_id) ON DELETE SET NULL');
    expect(sql).toContain("CONSTRAINT chk_pom_active_payment CHECK (removed_at IS NOT NULL OR kind <> 'matched' OR payment_id IS NOT NULL)");
    expect(sql).toContain('payment_id_at_match BIGINT NULL');
    // The command registry must survive the payment: no FK to payments there.
    const commands = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.payment_onec_commands'), sql.indexOf('-- Подсказка типа оплаты'));
    expect(commands).toContain('payment_id BIGINT NOT NULL,');
    expect(commands).not.toContain('REFERENCES public.payments');
  });

  it('one active record per 1C line and per payment; one active link per 1C order and per ERP order', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_pom_line\s+ON public\.payment_onec_matches \(onec_document_line_id\) WHERE removed_at IS NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_pom_payment\s+ON public\.payment_onec_matches \(payment_id\) WHERE removed_at IS NULL AND payment_id IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_ooo_links_onec\s+ON public\.order_onec_order_links \(source_id, onec_order_ref_key\) WHERE removed_at IS NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_ooo_links_order\s+ON public\.order_onec_order_links \(order_id\) WHERE removed_at IS NULL AND order_id IS NOT NULL;/);
  });

  it('seeds the permissions only for roles that already have the base rights and never overwrites a role setting', () => {
    expect(sql).toContain("'payments.onec.view'");
    expect(sql).toContain("'payments.onec.manage'");
    const grants = sql.slice(sql.indexOf('INSERT INTO public.role_permissions'));
    expect(grants.match(/ON CONFLICT \(role_id, permission_name\) DO NOTHING;/g)).toHaveLength(2);
    expect(grants).not.toMatch(/DO UPDATE/);
    expect(grants).toContain("rp.permission_name = 'finance.view' AND rp.is_enabled");
    expect(grants).toContain("pc.permission_name = 'payments.create' AND pc.is_enabled");
    expect(grants).toContain("pu.permission_name = 'payments.update' AND pu.is_enabled");
    expect(sql).toContain('UPDATE public.permissions_state SET version = version + 1');
  });

  it('probes the end state before recording the ledger', () => {
    expect(runner).toContain('240_payment_onec_matches*) probe_all');
    for (const table of ['order_onec_order_links', 'payment_onec_matches', 'payment_onec_commands', 'onec_account_payment_types']) {
      expect(runner).toContain(`q_tbl ${table}`);
    }
    expect(runner).toContain('q_con_on payment_onec_matches chk_pom_active_payment');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toContain('240_payment_onec_matches*');
  });
});
