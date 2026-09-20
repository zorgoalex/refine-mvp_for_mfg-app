import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { AuditService } from '../../../common/audit/audit.service';
import {
  stageError,
  type StageConfig,
  type StageOrder,
  type DealStage,
} from './stage-policy';

export interface StageActor {
  id: string;
  requestId: string;
}
export interface StageWork {
  member_id: string;
  category_id: number;
  order_id: string;
  epoch: number;
  revision: string;
  initialized: boolean;
  status: string;
  source_status_id: number;
  applied_status_id: number | null;
  attempts: number;
  restore_count: number;
  restore_window: Date | null;
  lock_token: string;
  actor_user_id: string | null;
  request_id: string;
  approval: StageApproval | null;
  job_id: string | null;
}
export interface StageApproval {
  orderId: string;
  statusId: number;
  orderVersion: number;
  bitrixId: string;
  observed: string;
  target: string;
  configVersion: number;
  epoch: number;
}
export interface StageCatalog {
  member_id: string;
  category_id: number;
  category_name: string;
  stages: DealStage[];
  revision: string;
  fetched_at: Date;
}
export interface StageJob {
  job_id: string;
  member_id: string;
  category_id: number;
  epoch: number;
  config_version: number;
  kind: 'settings' | 'reconcile' | 'provision';
  payload: Record<string, unknown>;
  results: Record<string, string>;
  actor_user_id: string;
  expires_at: Date;
}

export class StageRepository {
  constructor(readonly db: DatabaseService, readonly audit: AuditService) {}
  async config(client: DatabaseClient = this.db): Promise<StageConfig> {
    const { rows } = await client.query<StageConfig>(
      'SELECT * FROM bitrix24_stage_config WHERE singleton'
    );
    if (!rows[0])
      throw stageError('UNAVAILABLE', 'Не применена конфигурация стадий', 503);
    return rows[0];
  }
  async catalog(c: StageConfig): Promise<StageCatalog | null> {
    const { rows } = await this.db.query<StageCatalog>(
      'SELECT * FROM bitrix24_stage_catalog WHERE member_id=$1 AND category_id=$2',
      [c.member_id, c.category_id]
    );
    return rows[0] ?? null;
  }
  async order(
    id: string,
    client: DatabaseClient = this.db
  ): Promise<StageOrder | null> {
    const { rows } = await client.query<StageOrder>(
      `SELECT o.order_id::text,o.order_name,o.order_status_id,o.order_kind,o.delete_flag,o.client_id::text,o.version,
      m.bitrix_id,m.status AS mapping_status,m.source_system,r.bitrix_deal_id AS request_deal,r.linked_order_id::text,r.state AS request_state
      FROM orders o LEFT JOIN crm_sync_mapping m ON m.entity_type='order' AND m.erp_id=o.order_id::text AND m.bitrix_object='deal'
      LEFT JOIN LATERAL (SELECT bitrix_deal_id,linked_order_id,state FROM bitrix24_incoming_request WHERE linked_order_id=o.order_id AND bitrix_deal_id=m.bitrix_id LIMIT 1) r ON true
      WHERE o.order_id=$1`,
      [id]
    );
    return rows[0] ?? null;
  }
  async mappings(
    c: StageConfig
  ): Promise<Array<{ order_status_id: number; stage_id: string }>> {
    return (
      await this.db.query<{ order_status_id: number; stage_id: string }>(
        'SELECT order_status_id,stage_id FROM bitrix24_stage_mapping WHERE member_id=$1 AND category_id=$2',
        [c.member_id, c.category_id]
      )
    ).rows;
  }
  async record(
    client: DatabaseClient,
    event: string,
    actor: StageActor,
    metadata: Record<string, unknown>,
    order?: StageOrder
  ): Promise<void> {
    await this.audit.record(client, {
      event: `crm_sync.stage_${event}`,
      entityType: order ? 'order' : 'bitrix24_stage_config',
      entityId: order?.order_id ?? '1',
      source: 'crm-sync',
      actorUserId: actor.id || null,
      requestId: actor.requestId,
      relatedOrderId: order ? Number(order.order_id) : null,
      relatedClientId: order ? Number(order.client_id) : null,
      statusField: order ? 'order_status_id' : undefined,
      statusId: order?.order_status_id,
      before:
        typeof metadata.before === 'object'
          ? (metadata.before as Record<string, unknown>)
          : undefined,
      after:
        typeof metadata.after === 'object'
          ? (metadata.after as Record<string, unknown>)
          : undefined,
      stageCode:
        typeof metadata.targetStage === 'string'
          ? metadata.targetStage
          : undefined,
      metadata: {
        ...metadata,
        ...(order?.bitrix_id
          ? { bitrixObject: 'deal', bitrixId: order.bitrix_id }
          : {}),
      },
    });
  }
  async claim(leaseMs: number): Promise<StageWork | null> {
    const { rows } = await this.db.query<StageWork>(
      `UPDATE bitrix24_stage_work w SET status='processing',lock_token=gen_random_uuid(),locked_at=now()
      WHERE (w.member_id,w.category_id,w.order_id) IN (SELECT x.member_id,x.category_id,x.order_id FROM bitrix24_stage_work x JOIN bitrix24_stage_config c ON c.enabled AND x.member_id=c.member_id AND x.category_id=c.category_id AND x.epoch=c.epoch
        WHERE ((x.status IN ('pending','waiting_mapping') AND x.next_attempt_at<=now()) OR (x.status='processing' AND x.locked_at<now()-($1::double precision*interval '1 millisecond')))
        ORDER BY x.next_attempt_at,x.order_id LIMIT 1 FOR UPDATE OF x SKIP LOCKED) RETURNING w.*`,
      [leaseMs]
    );
    return rows[0] ?? null;
  }
  async prove(w: StageWork, c: StageConfig): Promise<void> {
    const r = await this.db.query(
      `UPDATE bitrix24_stage_work w SET locked_at=now() FROM bitrix24_stage_config c
      WHERE w.member_id=$1 AND w.category_id=$2 AND w.order_id=$3 AND w.lock_token=$4::uuid AND w.revision=$5::bigint AND w.epoch=$6 AND w.status='processing'
        AND c.enabled AND c.member_id=w.member_id AND c.category_id=w.category_id AND c.epoch=w.epoch AND c.version=$7
        AND EXISTS(SELECT 1 FROM bitrix24_app_installation i WHERE i.member_id=c.member_id AND i.domain=c.domain AND i.status='active')`,
      [
        w.member_id,
        w.category_id,
        w.order_id,
        w.lock_token,
        w.revision,
        w.epoch,
        c.version,
      ]
    );
    if (r.rowCount !== 1)
      throw stageError('STALE_WORK', 'Задание устарело или отключено');
  }
  async prepare(
    w: StageWork,
    c: StageConfig,
    order: StageOrder,
    before: string,
    target: string
  ): Promise<string> {
    await this.prove(w, c);
    return this.db.transaction(async (tx) => {
      const owned = await tx.query(
        `UPDATE bitrix24_stage_work w SET restore_count=CASE WHEN $8::boolean THEN CASE WHEN restore_window>now()-interval '10 minutes' THEN restore_count+1 ELSE 1 END ELSE restore_count END,
        restore_window=CASE WHEN $8::boolean AND (restore_window IS NULL OR restore_window<=now()-interval '10 minutes') THEN now() ELSE restore_window END,
        target_stage=$9::text,observed_stage=$10::text,bitrix_id=$11::text
        FROM bitrix24_stage_config c WHERE w.member_id=$1 AND w.category_id=$2 AND w.order_id=$3 AND w.lock_token=$4::uuid AND w.revision=$5::bigint AND w.epoch=$6 AND w.status='processing'
        AND c.enabled AND c.member_id=w.member_id AND c.category_id=w.category_id AND c.epoch=w.epoch AND c.version=$7
        AND (NOT $8::boolean OR w.restore_window IS NULL OR w.restore_window<=now()-interval '10 minutes' OR w.restore_count<3)`,
        [
          w.member_id,
          w.category_id,
          w.order_id,
          w.lock_token,
          w.revision,
          w.epoch,
          c.version,
          true,
          target,
          before,
          order.bitrix_id,
        ]
      );
      if (owned.rowCount !== 1)
        throw stageError(
          'AUTOMATION_CONFLICT',
          'Повторное изменение стадии автоматизацией Bitrix. Требуется проверка роботов'
        );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO bitrix24_stage_attempt(attempt_id,member_id,category_id,order_id,epoch,revision,config_version,bitrix_id,before_stage,target_stage,actor_user_id,request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          w.member_id,
          w.category_id,
          w.order_id,
          w.epoch,
          w.revision,
          c.version,
          order.bitrix_id,
          before,
          target,
          w.actor_user_id,
          w.request_id,
        ]
      );
      return id;
    });
  }
  async finish(
    w: StageWork,
    c: StageConfig,
    order: StageOrder | null,
    status: 'processed' | 'pending' | 'blocked' | 'failed' | 'waiting_mapping',
    error: string | null,
    remoteStage?: string,
    target?: string,
    event?: string
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const r = await tx.query(
        `UPDATE bitrix24_stage_work w SET status=$8::text,last_error=$9::text,
        initialized=CASE WHEN $8::text='processed' THEN true ELSE initialized END,
        restore_count=CASE WHEN $8::text='processed' AND applied_status_id IS DISTINCT FROM source_status_id THEN 0 ELSE restore_count END,
        restore_window=CASE WHEN $8::text='processed' AND applied_status_id IS DISTINCT FROM source_status_id THEN NULL ELSE restore_window END,
        applied_status_id=CASE WHEN $8::text='processed' THEN source_status_id ELSE applied_status_id END,
        attempts=CASE WHEN $8::text='pending' THEN attempts+1 ELSE attempts END,
        observed_stage=COALESCE($10::text,observed_stage),target_stage=COALESCE($11::text,target_stage),bitrix_id=COALESCE($12::text,bitrix_id),
        lock_token=NULL,locked_at=NULL,next_attempt_at=now()+interval '60 seconds',updated_at=now(),processed_at=CASE WHEN $8::text='processed' THEN now() ELSE processed_at END
        FROM bitrix24_stage_config c WHERE w.member_id=$1 AND w.category_id=$2 AND w.order_id=$3 AND w.lock_token=$4::uuid AND w.revision=$5::bigint AND w.epoch=$6 AND w.status='processing'
        AND c.enabled AND c.member_id=w.member_id AND c.category_id=w.category_id AND c.epoch=w.epoch AND c.version=$7`,
        [
          w.member_id,
          w.category_id,
          w.order_id,
          w.lock_token,
          w.revision,
          w.epoch,
          c.version,
          status,
          error,
          remoteStage ?? null,
          target ?? null,
          order?.bitrix_id ?? null,
        ]
      );
      if (r.rowCount && w.job_id)
        await tx.query(
          'UPDATE bitrix24_stage_job SET results=results||jsonb_build_object($2::text,$3::text) WHERE job_id=$1',
          [
            w.job_id,
            w.order_id,
            error ?? (status === 'processed' ? 'Выполнено' : status),
          ]
        );
      if (r.rowCount && event)
        await this.record(
          tx,
          event,
          { id: w.actor_user_id ?? '', requestId: w.request_id },
          {
            bitrixId: order?.bitrix_id,
            memberId: w.member_id,
            categoryId: w.category_id,
            epoch: w.epoch,
            revision: w.revision,
            error,
            before: {
              stageId: w.initialized ? w.approval?.observed ?? null : null,
            },
            after: { stageId: remoteStage ?? null },
            targetStage: target,
          },
          order ?? undefined
        );
      // Source changed during HTTP: release only our lease; never clear newer work.
      if (!r.rowCount)
        await tx.query(
          `UPDATE bitrix24_stage_work w SET status='pending',locked_at=NULL,lock_token=NULL,next_attempt_at=now()
        FROM bitrix24_stage_config c WHERE w.member_id=$1 AND w.category_id=$2 AND w.order_id=$3 AND w.lock_token=$4::uuid AND w.epoch=$5 AND w.status='processing'
        AND c.enabled AND c.member_id=w.member_id AND c.category_id=w.category_id AND c.epoch=w.epoch`,
          [w.member_id, w.category_id, w.order_id, w.lock_token, w.epoch]
        );
    });
  }
  async observe(
    tx: DatabaseClient,
    member: string,
    dealId: string,
    category: number,
    stage: string
  ): Promise<void> {
    // Called in the inbound ownership transaction. Existing enrollment only;
    // no dependence on payment reconcile or normalized-hash shortcut.
    await tx.query(
      `UPDATE bitrix24_stage_work w SET status=CASE WHEN w.status='processing' THEN 'processing' ELSE 'pending' END,
      revision=w.revision+1,next_attempt_at=now(),observed_stage=$4,updated_at=now()
      FROM bitrix24_stage_config c,crm_sync_mapping m,orders o
      WHERE c.enabled AND c.member_id=$1 AND c.category_id=$3 AND w.member_id=c.member_id AND w.category_id=c.category_id AND w.epoch=c.epoch
        AND m.entity_type='order' AND m.bitrix_object='deal' AND m.bitrix_id=$2 AND m.erp_id=w.order_id::text AND m.status IN ('active','failed')
        AND o.order_id=w.order_id AND o.order_kind='production_order' AND NOT o.delete_flag
        AND w.status IN ('processed','waiting_mapping') AND (NOT w.initialized OR w.target_stage IS DISTINCT FROM $4::text)`,
      [member, dealId, category, stage]
    );
  }
}
