import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '279_bazis_project_cards.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 279: Bazis project cards (doweling orders with a client)', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).toContain('ADD COLUMN IF NOT EXISTS client_id bigint');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS doweling_order_id bigint');
    for (const table of ['tmp_card_clients', 'tmp_split_resolution', 'tmp_client_backfill', 'tmp_xml_candidates']) {
      expect(code).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
    // backfill touches only unset rows
    expect(code).toContain('WHERE d.client_id IS NULL');
    expect(code).toContain('AND bp.doweling_order_id IS NULL');
    for (const trigger of ['ctrg_odl_bazis_client', 'ctrg_doweling_orders_bazis_client', 'ctrg_orders_bazis_client',
      'ctrg_bazis_projects_client', 'ctrg_projects_bazis_client', 'trg_doweling_orders_default_client']) {
      expect(code).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it('stops without writing on conflicting clients and on ambiguous XML cards', () => {
    expect(code).toContain("'STOP 279: присадки с заказами разных клиентов");
    expect(code).toContain("'STOP 279: XML-проекты с неоднозначной карточкой");
    expect(code).toContain("'STOP 279: инвариант клиента нарушен после переноса");
    // only the user-approved split («1289»: keep 2269, unlink 2290) is resolved automatically
    expect(code).toContain("d.doweling_order_name = '1289'");
    expect(code).toContain("keep.order_name = '2269'");
    expect(code).toContain("dropo.order_name = '2290'");
  });

  it('takes the card client from live orders, then deleted orders, then «нд»', () => {
    expect(code).toContain('coalesce(r.keep_client_id, c.live_clients[1], c.dead_clients[1], public.bazis_nd_client_id())');
    expect(code).toContain("lower(btrim(client_name)) = 'нд' AND is_active");
    expect(code).toContain('ALTER TABLE public.doweling_orders ALTER COLUMN client_id SET NOT NULL;');
  });

  it('keeps the design engineer mandatory and links XML only to a same-client single candidate', () => {
    expect(code).not.toMatch(/design_engineer_id\s+DROP NOT NULL/i);
    expect(code).toContain('AND bp.design_engineer_id IS NOT NULL');
    expect(code).toContain('AND c.card_clients[1] = c.group_client_id');
  });

  it('audits the migration with the system actor and writes no outbox', () => {
    for (const event of ['doweling.client_backfilled', 'doweling.link_removed_by_migration', 'doweling.created',
      'bazis.project_card_linked']) {
      expect(code).toContain(`'${event}'`);
    }
    expect(code).toContain("'migration-279'");
    expect(code).not.toMatch(/outbox_events/);
  });

  it('checks the client invariant with read-only deferred triggers, default cards excluded', () => {
    expect(code).toContain("AND d.client_source <> 'default'");
    expect(code).toContain("CONSTRAINT = 'chk_bazis_project_client'");
    expect(code.match(/CREATE CONSTRAINT TRIGGER/g)).toHaveLength(5);
    expect(code.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(5);
    // restore from the trash re-checks the order's cards
    expect(code).toContain('WHEN (NEW.client_id IS DISTINCT FROM OLD.client_id OR (OLD.delete_flag AND NOT NEW.delete_flag))');
    const checkFunctions = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_link'),
      code.indexOf('DROP TRIGGER IF EXISTS ctrg_odl_bazis_client'));
    expect(checkFunctions).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(checkFunctions).not.toMatch(/FOR (UPDATE|SHARE)/);
  });

  it('fills a client for inserts of the previous backend', () => {
    expect(code).toContain("NEW.client_source := 'default';");
    expect(code).toContain("NEW.client_source := 'order';");
    expect(code).toContain('BEFORE INSERT ON public.doweling_orders');
  });

  it('reads the order’s Bazis project from its latest active link', () => {
    expect(code).toContain("'LEFT JOIN doweling_orders d ON ord\\.order_id = d\\.order_id'");
    expect(code).toContain('ORDER BY l.order_doweling_link_id DESC LIMIT 1) d ON true');
    expect(code).toContain("'STOP 279: в orders_view не найдено соединение с doweling_orders по order_id'");
    // doweling_orders_view keeps its column order; client_source is appended
    expect(code).toMatch(/d\.delete_flag,\s+d\.client_source,\s+\(SELECT count\(\*\) FROM public\.bazis_projects bp/);
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('279_bazis_project_cards*) probe_all');
    expect(runner).toContain('|279_bazis_project_cards*)');
  });
});
