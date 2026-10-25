import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mdfDemandMaterialSql } from '../../../shared/cnc-material';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF demand material: engine loader = order board flag PostgreSQL', () => {
  const schema = `e2e_mdf_demand_${randomUUID().replaceAll('-','')}`;
  const db = new Client({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000' });
  beforeAll(async () => {
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const table of ['orders','order_details','production_statuses','materials','sheet_material_types']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query(`INSERT INTO materials(material_id,material_name) VALUES(1,'MDF 16 мм'),(2,'ХДФ 3 мм'),(3,'ЛДСП белый'),(4,NULL);
      INSERT INTO sheet_material_types(sheet_material_type_id,name) VALUES(1,'МДФ 19'),(2,'МДФ/ДСП');
      INSERT INTO orders(order_id,order_name,delete_flag,order_kind) VALUES(1,'E2E-Тест demand',false,'production_order')`);
  });
  afterAll(async () => { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); });

  it('classifies every material combination identically', async () => {
    // [detail, material, sheet type]: sheet type wins over the legacy material.
    const rows: [number, number | null, number | null][] = [[1,1,null],[2,2,null],[3,3,null],[4,4,null],[5,null,1],
      [6,2,1],[7,1,2],[8,null,null]];
    for (const [detailId,materialId,sheetTypeId] of rows) {
      await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,material_id,sheet_material_type_id,delete_flag)
        VALUES($1,1,$2,2,$3,$4,false)`,[detailId,detailId,materialId,sheetTypeId]);
    }
    const tx = { raw: db, query: (sql: string, args?: readonly unknown[]) => db.query(sql, args ? [...args] : []) };
    const engine = (await loadMdfExecutionDetails(tx as never,[1])).map(d => d.detailId);
    const board = (await db.query<{ detail_id: number; eligible: boolean }>(`SELECT od.detail_id::float8 detail_id,
      ${mdfDemandMaterialSql('mt','m')} eligible FROM order_details od
      LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id = od.sheet_material_type_id
      LEFT JOIN materials m ON m.material_id = od.material_id ORDER BY od.detail_id`)).rows;
    expect(engine).toEqual([1,5,6]);
    expect(board.filter(r => r.eligible).map(r => Number(r.detail_id))).toEqual(engine);
  });
});
