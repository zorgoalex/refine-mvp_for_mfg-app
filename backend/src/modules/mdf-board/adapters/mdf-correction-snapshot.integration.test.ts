import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverMdfCorrectionClosure, loadMdfCorrectionSnapshot } from './mdf-correction-snapshot';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import type { TransactionClient } from '../../../database/database.types';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('active MDF correction material scope, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e179mat');
  const packetId = '00000000-0000-0000-0000-000000000179';
  const demand = [1, 2, 3].map(orderId => ({ orderId, detailId: orderId * 100 + 1, quantity: 2 }));
  const tx = fixture.client as unknown as TransactionClient;

  beforeAll(async () => {
    await fixture.connect();
    await fixture.clonePublicTables(['orders', 'order_details', 'order_statuses', 'production_statuses',
      'materials', 'sheet_material_types', 'users', 'order_workshops', 'cnc_telegram_packets',
      'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys', 'mdf_board_manual_moves']);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.cnc_telegram_packets
      ADD COLUMN IF NOT EXISTS mdf_completion_returned boolean NOT NULL DEFAULT false;
      ALTER TABLE ${fixture.schema}.cnc_telegram_packets ADD PRIMARY KEY(packet_id)`);
    await fixture.applyMigrations(['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql', '178_mdf_correction_receipts.sql',
      '179_mdf_active_return.sql']);
    await fixture.client.query(`
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E MDF material scope',1,true);
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES(1,'E2E',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','E2E new',1,true);
      INSERT INTO materials(material_id,material_name) VALUES
        (1,'МДФ фасад 10 мм'),(2,'МДФ фасад 16 мм'),(3,'МДФ фасад 18 мм'),
        (4,'HDF 3 мм'),(5,'ЛДСП 16 мм'),(6,'Фанера 12 мм');
      INSERT INTO orders(order_id,order_name,order_kind,order_status_id,delete_flag,version,created_by)
        SELECT n,'E2E material '||n,'production_order',1,false,1,1 FROM generate_series(1,6) n;
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        SELECT n*100+1,n,1,2,1,false,n FROM generate_series(1,3) n;
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES (102,1,2,2,1,false,4),(103,1,3,2,1,false,5),(104,1,4,2,1,false,6);
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES (202,2,2,2,1,false,4),(203,2,3,2,1,false,5),(204,2,4,2,1,false,6);
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES (302,3,2,2,1,false,4),(303,3,3,2,1,false,5),(304,3,4,2,1,false,6);
    `);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,source_version,
      payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,'E2E correction material','E2E','179',1,repeat('a',64),CURRENT_DATE,'pending',false,NULL,
        'МДФ фасад','E2E','machine_file',now(),now(),'parsed',false,false)`, [packetId]);
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('packet',$1,'r1',$2,'derived',1,'E2E correction material','E2E correction material')`,
    [packetId, 'b'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,
      display_name,prior_column,composition_complete,demand_digest,acceptance_requested)
      VALUES('packet',$1,'r1','2026-09-20','E2E correction material','parsed',true,$2,true)`,
    [packetId, mdfDemandDigest(demand)]);
    for (const item of demand) {
      await fixture.client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
        VALUES('packet',$1,'r1',$2,$3,$4)`, [packetId, item.orderId, item.detailId, item.quantity]);
      await fixture.client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,
        quantity,stage_code,evidence_kind,rework) VALUES('packet',$1,'r1',$2,$3,$4,$5,'membership','derived',false)`,
      [packetId, `line-${item.orderId}`, item.orderId, item.detailId, item.quantity]);
    }
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet',$1,'r1')`, [packetId]);
    await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('packet',$1,'r1','r1')`, [packetId]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('discovers accepted source owners and snapshots only MDF facade 10/16/18 details', async () => {
    await fixture.assertLocalRelations(['orders', 'order_details', 'order_statuses', 'production_statuses',
      'materials', 'sheet_material_types', 'users', 'cnc_telegram_packets', 'mdf_source_heads',
      'mdf_revision_context', 'mdf_revision_demand', 'mdf_evidence_lines', 'mdf_correction_command_results',
      'mdf_correction_job_effect_suppressions', 'mdf_cnc_return_fences']);
    const closure = await discoverMdfCorrectionClosure(tx, { kind: 'packet', id: packetId });
    expect(closure.orders).toEqual([1, 2, 3]);
    const snapshot = await loadMdfCorrectionSnapshot(tx, { kind: 'packet', id: packetId }, closure);
    expect(snapshot.heads).toMatchObject([{ accepted: 'r1', received: 'r1', epoch: '0' }]);
    expect(snapshot.sourceIssues.get(JSON.stringify(['packet', packetId]))).toEqual([]);
    expect(snapshot.details.map(row => row.detailId)).toEqual([101, 201, 301]);
    expect(snapshot.details.every(row => row.quantity === 2)).toBe(true);
  });
});
