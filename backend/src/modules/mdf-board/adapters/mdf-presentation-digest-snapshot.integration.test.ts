import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Hybrid MDF board: the legacy card presentation and its digest must come from ONE snapshot. Two sessions show why the
// board read uses REPEATABLE READ: under READ COMMITTED a change committed between the reads yields a digest of data the
// card never showed (unchanged quantities, changed size), which would bind an old presentation to a new revision.
describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF presentation digest snapshot PostgreSQL', () => {
  const schema = `e2e_mdf_digest_${randomUUID().replaceAll('-','')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
    options: `-c statement_timeout=15000 -c lock_timeout=3000 -c search_path=${schema},public` };
  const reader = new Client(config), writer = new Client(config);
  const packetId = randomUUID();
  const digest = async (client: Client) => (await client.query<{ d: string }>(
    "SELECT mdf_source_presentation_digest('packet',$1) d", [packetId])).rows[0].d;
  const width = async (client: Client) => (await client.query<{ w: string }>(
    'SELECT width_mm::text w FROM cnc_telegram_packet_items WHERE packet_id=$1', [packetId])).rows[0].w;

  beforeAll(async () => {
    await reader.connect(); await writer.connect();
    await reader.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['cnc_telegram_packets','cnc_telegram_packet_items']) {
      await reader.query(`CREATE TABLE ${schema}.${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await reader.query(`INSERT INTO cnc_telegram_packets(packet_id,program_name,material_name) VALUES($1,'E2E-Тест','МДФ 16')`,
      [packetId]);
    await reader.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
      match_detail_id,detail_number,width_mm,height_mm,quantity) VALUES(gen_random_uuid(),$1,'1',1,1,1,100,200,2)`, [packetId]);
  });
  afterAll(async () => {
    await reader.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await reader.end(); await writer.end();
  });

  it('REPEATABLE READ keeps the digest of the presentation read earlier in the same transaction', async () => {
    const before = await digest(writer);
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      expect(Number(await width(reader))).toBe(100);
      await writer.query('UPDATE cnc_telegram_packet_items SET width_mm=150 WHERE packet_id=$1', [packetId]);
      expect(await digest(reader)).toBe(before);
    } finally { await reader.query('COMMIT'); }
    expect(await digest(reader)).not.toBe(before);
  });

  it('READ COMMITTED would mix them (the race the board read must not have)', async () => {
    const before = await digest(writer);
    await reader.query('BEGIN');
    try {
      const shown = await width(reader);
      await writer.query('UPDATE cnc_telegram_packet_items SET width_mm=width_mm+1 WHERE packet_id=$1', [packetId]);
      expect(await digest(reader)).not.toBe(before);
      expect(await width(reader)).not.toBe(shown);
    } finally { await reader.query('COMMIT'); }
  });
});
