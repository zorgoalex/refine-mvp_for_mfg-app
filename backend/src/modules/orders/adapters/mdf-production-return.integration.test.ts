import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PgMdfProductionReturn } from "./pg-mdf-production-return";
import type { CurrentUser } from "../../../permissions/current-user";
import type { TransactionClient } from "../../../database/database.types";
import { getPermissionsForRole } from "../../../permissions/permissions";
import { mdfCompletionUpdateSql } from "../../cnc-telegram/adapters/pg-cnc-telegram-repository";
import { PgMdfBoardManualMoveRepository } from "./pg-mdf-board-manual-move-repository";

const enabled = process.env.MDF_RETURN_INTEGRATION === "1";
const tables = [
  "orders",
  "order_details",
  "order_hdf_details",
  "order_statuses",
  "production_statuses",
  "order_workshops",
  "users",
  "cnc_telegram_packets",
  "cnc_telegram_packet_items",
  "cnc_telegram_packet_whole_order_keys",
  "mdf_board_manual_moves",
  "cut_job",
  "cut_result",
  "cut_result_board_projection",
  "cut_result_label_map_projection",
  "cut_result_archive_state",
  "cut_result_placement",
  "cut_result_sheet_map",
  "cut_param_profiles",
  "bazis_cut_sets",
  "bazis_cut_set_details",
  "materials",
  "sheet_material_types",
  "app_settings",
  "status_automation_rules",
  "outbox_events",
  "audit_log",
  "audit_log_related_entity",
  "command_idempotency_keys",
];
const packetId = "00000000-0000-0000-0000-000000000101";
const source = { kind: "packet" as const, id: packetId };
const user: CurrentUser = {
  id: "1",
  username: "E2E-Тест возврат",
  role: "admin",
  roleId: 1,
  permissions: getPermissionsForRole("admin"),
};

describe.skipIf(!enabled)(
  "MDF correction real PostgreSQL, owned isolated schema",
  { timeout: 30000 },
  () => {
    const schema = `e2e_mdf_return_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({
      host:
        process.env.PG_TAILSCALE_BIND_IP ||
        process.env.PG_BIND_IP ||
        "127.0.0.1",
      database: process.env.PG_DB,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      connectionTimeoutMillis: 5000,
      options:
        "-c statement_timeout=20000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off",
    });
    const tx: TransactionClient = {
      query: (text, params) => client.query(text, params ? [...params] : []),
      raw: client as unknown as PoolClient,
    };
    const database = {
      transaction: async <T>(
        handler: (tx: TransactionClient) => Promise<T>
      ) => {
        await client.query("BEGIN");
        try {
          const result = await handler(tx);
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      },
    };
    const repository = new PgMdfProductionReturn(database);
    beforeAll(async () => {
      await client.connect();
      await client.query(
        `CREATE SCHEMA ${schema}; SET search_path=${schema},public`
      );
      for (const table of tables)
        await client.query(
          `CREATE TABLE ${schema}.${table} AS TABLE public.${table} WITH NO DATA`
        );
      await client.query(`ALTER TABLE cnc_telegram_packets ADD COLUMN IF NOT EXISTS mdf_completion_returned boolean NOT NULL DEFAULT false;
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE mdf_board_manual_moves ALTER COLUMN move_id SET DEFAULT 1;
      ALTER TABLE mdf_board_manual_moves ALTER COLUMN version SET DEFAULT 1;
      CREATE UNIQUE INDEX return_move_key ON mdf_board_manual_moves(card_kind,card_id);
      CREATE UNIQUE INDEX return_idempotency_key ON command_idempotency_keys(idempotency_key);
      CREATE UNIQUE INDEX return_outbox_key ON outbox_events(idempotency_key);
      CREATE UNIQUE INDEX return_related_key ON audit_log_related_entity(audit_id,entity_type,entity_id);`);
      const migration = readFileSync(
        new URL(
          "../../../../db/migrations/155_order_production_composition.sql",
          import.meta.url
        ),
        "utf8"
      )
        .replace(/^BEGIN;$/m, "")
        .replace(/^COMMIT;$/m, "");
      await client.query(migration);
    }, 30000);
    afterAll(async () => {
      try {
        await client.query(
          `SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`
        );
        expect(
          (
            await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [
              schema,
            ])
          ).rows
        ).toHaveLength(0);
      } finally {
        await client.end();
      }
    });
    beforeEach(async () => {
      await client.query(`TRUNCATE ${tables
        .map((t) => `${schema}.${t}`)
        .join(",")};
      INSERT INTO users(user_id,username,is_active) VALUES(1,'E2E-Тест',true);
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true),(4,'Завершён',40,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',20,true),(4,'sanded','Отшлифован',40,true),
        (6,'laminated','Закатан',70,true),(7,'packed','Упакован',80,true),(8,'issued','Выдан',90,true);
      INSERT INTO orders(order_id,order_name,order_kind,order_status_id,delete_flag,version,created_by)
        VALUES(1,'E2E-Тест 1','production_order',3,false,1,1),(2,'E2E-Тест 2','production_order',1,false,1,1);
      INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,width,height)
        VALUES(11,1,1,10,8,false,100,200),(12,1,2,2,NULL,false,100,200),(13,1,3,1,7,false,100,200),(21,2,1,2,1,false,100,200);
      INSERT INTO order_hdf_details(order_id,production_status_id) VALUES(1,8);
      INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,source_version,
        payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,parse_status,rework,mdf_completion_returned)
        VALUES('${packetId}','E2E-Тест','E2E-Test','1',1,'E2E-hash',CURRENT_DATE,'completed',true,now(),'МДФ 10мм',
        'E2E-MDF','machine_file',now(),now(),'parsed',false,false);
      INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,match_order_id,match_detail_id,quantity,
        order_name,detail_number,width_mm,height_mm,source,match_status)
        VALUES(gen_random_uuid(),'${packetId}',1,11,5,'E2E-Тест 1',1,100,200,'svg','matched');`);
    });
    const production = async () =>
      (
        await client.query(
          "SELECT detail_id,production_status_id FROM order_details ORDER BY detail_id"
        )
      ).rows;
    const confirm = async (
      preview: Awaited<ReturnType<typeof repository.preview>>,
      key = randomUUID()
    ) =>
      repository.confirm(
        user,
        source,
        {
          targetColumn: preview.targetColumn,
          productionStatusId: preview.targetStage.id,
          expectedDigest: preview.digest,
          idempotencyKey: key,
        },
        "E2E-return"
      );
    it("preview rolls back all facts; confirm changes only source position and explicitly reopens issued order", async () => {
      const before = await production();
      const p = await repository.preview(user, source, {
        targetColumn: "parsed",
      });
      expect(p.details.map((d) => d.detailId)).toEqual([11]);
      expect(p.details[0]).toMatchObject({
        quantity: 10,
        cardQuantity: 5,
        before: "Выдан",
        after: "Отрисован",
      });
      expect(p.orders).toEqual([
        {
          orderId: 1,
          orderName: "E2E-Тест 1",
          before: "Выдан",
          after: "В производстве",
        },
      ]);
      expect(p.cards).toContainEqual(
        expect.objectContaining({
          id: packetId,
          before: "completed_laminated",
          after: "parsed",
        })
      );
      expect(await production()).toEqual(before);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS n FROM mdf_board_manual_moves"
          )
        ).rows[0].n
      ).toBe(0);
      const key = randomUUID();
      const result = await confirm(p, key);
      expect(await production()).toEqual([
        { detail_id: "11", production_status_id: 1 },
        { detail_id: "12", production_status_id: null },
        { detail_id: "13", production_status_id: 7 },
        { detail_id: "21", production_status_id: 1 },
      ]);
      expect(
        (
          await client.query(
            "SELECT production_status_id FROM order_hdf_details"
          )
        ).rows[0].production_status_id
      ).toBe(8);
      expect(
        (
          await client.query(
            "SELECT order_status_id,production_unassigned_count FROM orders WHERE order_id=1"
          )
        ).rows[0]
      ).toMatchObject({ order_status_id: 1, production_unassigned_count: 1 });
      expect(
        (
          await client.query(
            "SELECT completion_status,thumbs_up,mdf_completion_returned FROM cnc_telegram_packets"
          )
        ).rows[0]
      ).toEqual({
        completion_status: "pending",
        thumbs_up: false,
        mdf_completion_returned: true,
      });
      expect(await confirm(p, key)).toEqual(result);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS n FROM audit_log WHERE event='mdf_board.production_returned'"
          )
        ).rows[0].n
      ).toBe(1);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS n FROM outbox_events WHERE event_type='mdf_board.production_returned'"
          )
        ).rows[0].n
      ).toBe(1);
    });
    it("rejects stale preview without changing any production facts", async () => {
      const p = await repository.preview(user, source, {
        targetColumn: "parsed",
      });
      await client.query(
        "UPDATE order_details SET quantity=12 WHERE detail_id=11"
      );
      const before = await production();
      await expect(confirm(p)).rejects.toMatchObject({
        code: "MDF_RETURN_STALE",
      });
      expect(await production()).toEqual(before);
    });
    it("completed order blocks; missing reopen permission blocks; unresolved source blocks", async () => {
      await client.query(
        "UPDATE orders SET order_status_id=4 WHERE order_id=1"
      );
      await expect(
        repository.preview(user, source, { targetColumn: "parsed" })
      ).rejects.toMatchObject({ code: "MDF_RETURN_ORDER_CLOSED" });
      await client.query(
        "UPDATE orders SET order_status_id=3 WHERE order_id=1"
      );
      await expect(
        repository.preview(
          {
            ...user,
            permissions: user.permissions.filter(
              (p) => p !== "orders.change_status"
            ),
          },
          source,
          { targetColumn: "parsed" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await client.query(
        "UPDATE cnc_telegram_packet_items SET match_detail_id=NULL,detail_number=NULL"
      );
      await expect(
        repository.preview(user, source, { targetColumn: "parsed" })
      ).rejects.toThrow();
    });

    const addProductionSources = () =>
      client.query(`
    INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,created_at) VALUES(101,'E2E-БАЗИС',now());
    INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_order_id,source_order_detail_id,
      source_order_name,sort_order,quantity,material_name,cut_enabled,finished_width_mm,finished_length_mm)
      VALUES(101,101,1,11,'E2E-Тест 1',1,5,'MDF 10mm',true,100,200);
    INSERT INTO cut_job(cut_job_id,name,status,current_cut_result_id) VALUES(101,'E2E-Ванна','calculated',101);
    INSERT INTO cut_result(cut_result_id,cut_job_id,result_no,revision_no,snapshot_digest,created_at) VALUES(101,101,1,1,'E2E',now());
    INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,is_vacuum,cut_job_name,result_created_at)
      VALUES(101,'E2E',true,'E2E-Ванна',now());
    INSERT INTO cut_result_label_map_projection(cut_result_id,snapshot_digest) VALUES(101,'E2E');
    INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,cut_group_id,is_effective,variant,
      sheet_index,sheet_ordinal,sheet_width_mm,sheet_height_mm) VALUES(101,101,101,true,'auto',0,1,1000,2000);
    INSERT INTO cut_result_placement(cut_result_id,cut_result_sheet_map_id,order_id,order_detail_id,instance)
      VALUES(101,101,1,11,1);`);

    it.each([
      ["bath", "cut-result:101", "baths_ready", 4],
      ["bazisCutSet", "101", "parsed", 1],
    ] as const)(
      "returns %s and previews all shared cards, not unrelated order details",
      async (kind, id, targetColumn, statusId) => {
        await addProductionSources();
        const own = { kind, id };
        const p = await repository.preview(user, own, { targetColumn });
        expect(p.details.map((d) => d.detailId)).toEqual([11]);
        expect(p.cards).toContainEqual(
          expect.objectContaining({ kind, id, after: targetColumn })
        );
        expect(p.cards).toContainEqual(
          expect.objectContaining({
            kind: "packet",
            id: packetId,
            after: "completed",
          })
        );
        await repository.confirm(
          user,
          own,
          {
            targetColumn,
            productionStatusId: p.targetStage.id,
            expectedDigest: p.digest,
            idempotencyKey: randomUUID(),
          },
          "E2E"
        );
        expect(
          (await production()).find((d) => d.detail_id === "11")
            .production_status_id
        ).toBe(statusId);
        expect(
          (await production()).find((d) => d.detail_id === "13")
            .production_status_id
        ).toBe(7);
      }
    );

    it("completion replay remains pending until source removal and a fresh completion", async () => {
      await confirm(
        await repository.preview(user, source, { targetColumn: "parsed" })
      );
      const ingest = async (completed: boolean) => {
        await client.query(
          `UPDATE cnc_telegram_packets SET ${mdfCompletionUpdateSql(
            "$2",
            "$3",
            "$4"
          )},source_version=source_version+1 WHERE packet_id=$1`,
          [
            packetId,
            completed ? "completed" : "pending",
            completed,
            completed ? new Date() : null,
          ]
        );
        return (
          await client.query(
            "SELECT completion_status,mdf_completion_returned FROM cnc_telegram_packets"
          )
        ).rows[0];
      };
      expect(await ingest(true)).toEqual({
        completion_status: "pending",
        mdf_completion_returned: true,
      });
      expect(await ingest(true)).toEqual({
        completion_status: "pending",
        mdf_completion_returned: true,
      });
      expect(await ingest(false)).toEqual({
        completion_status: "pending",
        mdf_completion_returned: false,
      });
      expect(await ingest(true)).toEqual({
        completion_status: "completed",
        mdf_completion_returned: false,
      });
    });

    it("legacy backward PUT blocks; explicit forward move clears return barrier", async () => {
      const manual = new PgMdfBoardManualMoveRepository(
        database as ConstructorParameters<
          typeof PgMdfBoardManualMoveRepository
        >[0]
      );
      const command = {
        currentUser: user,
        cardKind: "packet" as const,
        cardId: packetId,
        requestId: "E2E-manual",
      };
      await expect(
        manual.upsert({ ...command, targetColumn: "parsed" })
      ).rejects.toMatchObject({ code: "MDF_RETURN_CONFIRMATION_REQUIRED" });
      await confirm(
        await repository.preview(user, source, { targetColumn: "parsed" })
      );
      await manual.upsert({ ...command, targetColumn: "completed" });
      expect(
        (
          await client.query(
            "SELECT mdf_completion_returned FROM cnc_telegram_packets"
          )
        ).rows[0].mdf_completion_returned
      ).toBe(false);
    });

    it("failed audit atomically rolls back details, order, source, manual placement and receipt", async () => {
      const p = await repository.preview(user, source, {
        targetColumn: "parsed",
      });
      await client.query(
        `ALTER TABLE audit_log ADD CONSTRAINT e2e_reject_return CHECK(event <> 'mdf_board.production_returned')`
      );
      try {
        const before = await production();
        await expect(confirm(p)).rejects.toThrow();
        expect(await production()).toEqual(before);
        expect(
          (
            await client.query(
              "SELECT count(*)::int n FROM command_idempotency_keys"
            )
          ).rows[0].n
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT count(*)::int n FROM mdf_board_manual_moves"
            )
          ).rows[0].n
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT order_status_id FROM orders WHERE order_id=1"
            )
          ).rows[0].order_status_id
        ).toBe(3);
      } finally {
        await client.query(
          "ALTER TABLE audit_log DROP CONSTRAINT e2e_reject_return"
        );
      }
    });

    it("whole-order chat claim includes its ordinary positions and excludes HDF", async () => {
      await client.query(
        `INSERT INTO cnc_telegram_packet_whole_order_keys(packet_id,order_key) VALUES($1,'e2e-тест 1')`,
        [packetId]
      );
      const p = await repository.preview(user, source, {
        targetColumn: "parsed",
      });
      expect(p.details.map((d) => d.detailId)).toEqual([11, 13]);
      expect(p.warnings.join(" ")).toContain("весь заказ");
      await confirm(p);
      expect(
        (await production()).find((d) => d.detail_id === "12")
          .production_status_id
      ).toBeNull();
      expect(
        (
          await client.query(
            "SELECT production_status_id FROM order_hdf_details"
          )
        ).rows[0].production_status_id
      ).toBe(8);
    });

    it("mixed source preserves unrelated order version/mode when its detail needs no change", async () => {
      await client.query(
        `INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,match_order_id,match_detail_id,quantity,
      order_name,detail_number,width_mm,height_mm,source,match_status)
      VALUES(gen_random_uuid(),$1,2,21,2,'E2E-Тест 2',1,100,200,'svg','matched')`,
        [packetId]
      );
      const before = (
        await client.query(
          "SELECT version,production_status_from_details_enabled FROM orders WHERE order_id=2"
        )
      ).rows[0];
      const p = await repository.preview(user, source, {
        targetColumn: "parsed",
      });
      expect(p.details.map((d) => d.detailId)).toEqual([11]);
      await confirm(p);
      expect(
        (
          await client.query(
            "SELECT version,production_status_from_details_enabled FROM orders WHERE order_id=2"
          )
        ).rows[0]
      ).toEqual(before);
    });

    it('preserves existing manual production mode when reopening alone', async()=>{
      await client.query('UPDATE order_details SET production_status_id=1 WHERE detail_id=11');
      await client.query('UPDATE orders SET production_status_from_details_enabled=false WHERE order_id=1');
      const p=await repository.preview(user,source,{targetColumn:'parsed'});
      expect(p.details).toHaveLength(0);
      await confirm(p);
      expect((await client.query('SELECT order_status_id,production_status_id,production_status_from_details_enabled FROM orders WHERE order_id=1')).rows[0])
        .toEqual({order_status_id:1,production_status_id:null,production_status_from_details_enabled:false});
    });

    it('normalizes configured string order-status IDs like the visible board',async()=>{
      await addProductionSources();
      await client.query('UPDATE order_details SET production_status_id=2 WHERE detail_id=11');
      await client.query('UPDATE orders SET order_status_id=2 WHERE order_id=1');
      await client.query(`INSERT INTO app_settings(setting_key,value_json,is_active)
        VALUES('status_automation.mdf_board_hidden_production_statuses','{"cardRules":[{"cardKind":"bath","orderStatusIds":["2"]}]}',true)`);
      const own={kind:'bath' as const,id:'cut-result:101'};
      const p=await repository.preview(user,own,{targetColumn:'baths_ready'});
      expect(p.cards).toContainEqual(expect.objectContaining({kind:'bath',before:'completed_baths',after:'baths_ready'}));
    });

    it('preserves forward visual movement for an unresolved packet',async()=>{
      await client.query('DELETE FROM cnc_telegram_packet_items');
      await client.query("UPDATE cnc_telegram_packets SET completion_status='pending',thumbs_up=false");
      const manual=new PgMdfBoardManualMoveRepository(database as ConstructorParameters<typeof PgMdfBoardManualMoveRepository>[0]);
      await expect(manual.upsert({currentUser:user,cardKind:'packet',cardId:packetId,targetColumn:'completed',requestId:'E2E'}))
        .resolves.toMatchObject({changed:true});
      await expect(manual.upsert({currentUser:user,cardKind:'packet',cardId:packetId,targetColumn:'parsed',requestId:'E2E'}))
        .rejects.toMatchObject({code:'MDF_RETURN_CONFIRMATION_REQUIRED'});
    });

    it("fails fast when ingest owns packet lock, without an order/packet deadlock", async () => {
      const other = new Client({
        host:
          process.env.PG_TAILSCALE_BIND_IP ||
          process.env.PG_BIND_IP ||
          "127.0.0.1",
        database: process.env.PG_DB,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        connectionTimeoutMillis: 5000,
      });
      await other.connect();
      try {
        await other.query(`BEGIN; SET search_path=${schema},public`);
        await other.query(
          "SELECT packet_id FROM cnc_telegram_packets WHERE packet_id=$1 FOR UPDATE",
          [packetId]
        );
        await expect(
          repository.preview(user, source, { targetColumn: "parsed" })
        ).rejects.toMatchObject({ code: "MDF_RETURN_STALE" });
      } finally {
        await other.query("ROLLBACK");
        await other.end();
      }
    });
  }
);
