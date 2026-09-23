import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { DailyDigestStoredPage, DailyDigestSettingsInput, DailyDigestRun, DailyDigestPage, DailyDigestRunDetail, DailyDigestRunKind, DailyDigestRunState } from './daily-digest.types';
import type { DailyDigestSnapshot } from './daily-digest-snapshot.types';

interface SettingsRow extends QueryResultRow {
  version: number; enabled: boolean; group_chat_id: string | null; send_time: string;
  time_zone: string; catch_up_policy: string; catch_up_deadline: string; partial_policy: string; cards_per_message: number;
}
interface RunRow extends QueryResultRow {
  run_id: string; business_date: string | Date; kind: DailyDigestRunKind; parent_run_id: string | null;
  state: DailyDigestRunState; reason: string | null; order_count: number; total_area: string | number;
  page_count?: number; sent_page_count?: number; destination_chat_id: string;
  created_at: Date; updated_at: Date; image_expires_at: Date | null;
}
interface PageRow extends QueryResultRow {
  page_index: number; order_ids: number[]; state: DailyDigestPage['state']; attempt_count: number;
  provider_message_id: string | null; error_code: string | null; sent_at: Date | null;
  image_available: boolean; expires_at: Date; file_key: string; sha256: string;
}

@Injectable()
export class DailyDigestRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getSettings() {
    const row = (await this.database.query<SettingsRow>('SELECT * FROM whatsapp_daily_digest_settings WHERE singleton_id=1')).rows[0];
    if (!row) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_NOT_MIGRATED', 'Ежедневная рассылка не настроена');
    return mapSettings(row);
  }

  async updateSettings(input: DailyDigestSettingsInput, actor: CurrentUser, requestId: string) {
    return this.database.transaction(async tx => {
      const row = (await tx.query<SettingsRow>('SELECT * FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE')).rows[0];
      if (!row) throw new ApiError(503, 'WHATSAPP_DAILY_DIGEST_NOT_MIGRATED', 'Ежедневная рассылка не настроена');
      if (row.version !== input.version) throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_VERSION_CONFLICT', 'Настройки рассылки уже изменены');
      const next = (await tx.query<SettingsRow>(`
        UPDATE whatsapp_daily_digest_settings SET version=version+1,enabled=$2,group_chat_id=$3,
          send_time=$4::time,catch_up_policy=$5,catch_up_deadline=$6::time,partial_policy=$7,cards_per_message=$8,
          updated_by=$9,updated_at=now() WHERE singleton_id=1 AND version=$1 RETURNING *`,
        [input.version, input.enabled, input.groupChatId, input.sendTime, input.catchUpPolicy, input.catchUpDeadline, input.partialPolicy, input.cardsPerMessage, actor.id])).rows[0];
      if (!input.enabled) {
        await tx.query(`UPDATE whatsapp_daily_digest_pages p SET state='cancelled',error_code='DISABLED',updated_at=now()
          FROM whatsapp_daily_digest_runs r WHERE p.run_id=r.run_id AND (r.kind='auto' OR r.auto_origin) AND r.state IN ('queued','sending') AND p.state='pending'`);
        await tx.query(`UPDATE whatsapp_daily_digest_runs r SET
          state=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'unknown'
                     WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'partial' ELSE 'cancelled' END,
          reason=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'PROVIDER_OUTCOME_UNKNOWN'
                      WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'DISABLED_PARTIAL' ELSE 'DISABLED' END,
          updated_at=now()
          WHERE (r.kind='auto' OR r.auto_origin) AND r.state IN ('queued','sending')
            AND NOT EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state IN ('pending','sending'))`);
      }
      await this.audit(tx, actor, requestId, 'settings.updated', null, {
        version: next.version,
        before: { enabled: row.enabled, groupChatId: maskDestination(row.group_chat_id ?? ''), sendTime: String(row.send_time).slice(0, 5), catchUpPolicy: row.catch_up_policy, catchUpDeadline: String(row.catch_up_deadline).slice(0, 5), partialPolicy: row.partial_policy, cardsPerMessage: Number(row.cards_per_message) },
        after: { enabled: next.enabled, groupChatId: maskDestination(next.group_chat_id ?? ''), sendTime: String(next.send_time).slice(0, 5), catchUpPolicy: next.catch_up_policy, catchUpDeadline: String(next.catch_up_deadline).slice(0, 5), partialPolicy: next.partial_policy, cardsPerMessage: Number(next.cards_per_message) },
      });
      return mapSettings(next);
    });
  }

  async createRun(input: {
    runId: string; businessDate: string; kind: DailyDigestRunKind; parentRunId?: string | null;
    idempotencyKey: string; settingsVersion: number; destinationChatId: string; catchUpPolicy: string;
    deadlineAt: Date | null; partialPolicy: string; snapshot: DailyDigestSnapshot | null;
    orderCount: number; totalArea: number; state: DailyDigestRunState; reason?: string | null;
    actor?: CurrentUser; requestId?: string; retryDepth?: number; imageExpiresAt?: Date | null; requestDigest?: string;
  }, pages: DailyDigestStoredPage[] = [], beforeCommit?: () => Promise<void>): Promise<DailyDigestRunDetail> {
    return this.database.transaction(async tx => {
      await tx.query('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      if (input.kind !== 'retry') {
        const current = (await tx.query<{version:number}>('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1')).rows[0]?.version;
        if (current !== input.settingsVersion) throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_VERSION_CONFLICT', 'Настройки изменились во время подготовки рассылки');
      }
      try {
        await tx.query(`INSERT INTO whatsapp_daily_digest_runs(
          run_id,business_date,kind,parent_run_id,auto_origin,idempotency_key,request_digest,settings_version,destination_chat_id,
          catch_up_policy,deadline_at,partial_policy,snapshot,renderer_version,order_count,total_area,state,
          reason,actor_user_id,request_id,retry_depth,image_expires_at)
          VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [input.runId,input.businessDate,input.kind,input.parentRunId ?? null,input.kind==='auto',input.idempotencyKey,input.requestDigest ?? digest(input.kind==='manual' ? {kind:'manual',settingsVersion:input.settingsVersion,actorId:input.actor?.id ?? null} : {kind:input.kind,businessDate:input.businessDate,parentRunId:input.parentRunId ?? null,settingsVersion:input.settingsVersion,destination:input.destinationChatId,catchUpPolicy:input.catchUpPolicy,partialPolicy:input.partialPolicy}),input.settingsVersion,
          input.destinationChatId,input.catchUpPolicy,input.deadlineAt,input.partialPolicy,
          input.snapshot ? JSON.stringify(input.snapshot) : null,input.snapshot?.rendererVersion ?? 'none',
          input.orderCount,input.totalArea,input.state,input.reason ?? null,input.actor?.id ?? null,input.requestId ?? null,
          input.retryDepth ?? 0,input.imageExpiresAt ?? null]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'WHATSAPP_DAILY_DIGEST_DUPLICATE', 'Для этой даты уже создан запуск рассылки');
        throw error;
      }
      for (const page of pages) {
        await tx.query(`INSERT INTO whatsapp_daily_digest_pages(run_id,page_index,order_ids,file_key,sha256,size_bytes,expires_at,state)
          VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,'pending')`, [input.runId,page.pageIndex,JSON.stringify(page.orderIds),page.fileKey,page.sha256,page.sizeBytes,page.expiresAt]);
      }
      await this.audit(tx,input.actor,input.requestId,`run.${input.kind}`,input.runId,{businessDate:input.businessDate,orderCount:input.orderCount,pageCount:pages.length,totalArea:input.totalArea,orderIds:input.snapshot?.orders.map(order=>order.orderId) ?? []},input.snapshot?.orders.map(order=>order.orderId) ?? []);
      await beforeCommit?.();
      return this.getRunIn(tx,input.runId);
    });
  }

  async findByIdempotency(idempotencyKey: string, requestDigest?: string): Promise<DailyDigestRunDetail | null> {
    const row = (await this.database.query<{run_id:string;request_digest:string}>('SELECT run_id,request_digest FROM whatsapp_daily_digest_runs WHERE idempotency_key=$1',[idempotencyKey])).rows[0];
    if (row && requestDigest && row.request_digest !== requestDigest) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_IDEMPOTENCY_CONFLICT','Этот ключ уже использован для другой команды');
    return row ? this.getRun(row.run_id) : null;
  }

  async listRuns(): Promise<{runs:DailyDigestRun[]}> {
    const rows = await this.database.query<RunRow>(`${runSelect()} ORDER BY r.created_at DESC LIMIT 50`);
    return { runs: rows.rows.map(mapRun) };
  }

  async getRun(runId: string): Promise<DailyDigestRunDetail> {
    return this.getRunIn(this.database,runId);
  }

  async getSnapshot(runId: string): Promise<DailyDigestSnapshot | null> {
    const result = await this.database.query<{snapshot:DailyDigestSnapshot|null}>('SELECT snapshot FROM whatsapp_daily_digest_runs WHERE run_id=$1',[runId]);
    return result.rows[0]?.snapshot ?? null;
  }

  async getPageImageMetadata(runId: string, pageIndex: number) {
    const row = (await this.database.query<PageRow>(`SELECT *, (state='sent' OR expires_at>now()) AND expires_at>now() AS image_available
      FROM whatsapp_daily_digest_pages WHERE run_id=$1 AND page_index=$2`,[runId,pageIndex])).rows[0];
    if (!row) throw new ApiError(404,'WHATSAPP_DAILY_DIGEST_PAGE_NOT_FOUND','Страница рассылки не найдена');
    return { fileKey:row.file_key,sha256:row.sha256,expiresAt:row.expires_at,imageAvailable:row.image_available };
  }

  async createSendIntent(runId: string, pageIndex: number, runtimeEnabled: boolean): Promise<{token:string;destinationChatId:string;fileKey:string;sha256:string;expiresAt:Date}|null> {
    return this.database.transaction(async tx => {
      await tx.query('SELECT version,enabled FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const row = (await tx.query<{run_id:string;kind:string;auto_origin:boolean;state:string;reason:string|null;destination_chat_id:string;deadline_at:Date|null;file_key:string;sha256:string;expires_at:Date;page_state:string;next_attempt_at:Date;auto_enabled:boolean;order_ids:number[]}>(
        `SELECT r.run_id,r.kind,r.auto_origin,r.state,r.reason,r.destination_chat_id,r.deadline_at,p.file_key,p.sha256,p.expires_at,p.state page_state,p.next_attempt_at,p.order_ids,s.enabled auto_enabled
         FROM whatsapp_daily_digest_runs r JOIN whatsapp_daily_digest_pages p USING(run_id)
         JOIN whatsapp_daily_digest_settings s ON s.singleton_id=1
         WHERE r.run_id=$1 AND p.page_index=$2 FOR UPDATE OF r,p`,[runId,pageIndex])).rows[0];
      if (!row || row.page_state !== 'pending' || !['queued','sending'].includes(row.state)) return null;
      const earlier=(await tx.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages
        WHERE run_id=$1 AND page_index<$2 AND state<>'sent') blocked`,[runId,pageIndex])).rows[0]?.blocked;
      if (earlier) return null;
      if (row.next_attempt_at.getTime() > Date.now()) return null;
      if (row.expires_at.getTime() <= Date.now()) {
        await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='expired',error_code='IMAGE_EXPIRED',updated_at=now() WHERE run_id=$1 AND state='pending' AND expires_at<=now()`,[runId]);
        await this.reconcileTerminalRun(tx,runId,'IMAGE_EXPIRED');
        return null;
      }
      if (row.deadline_at && row.deadline_at.getTime() < Date.now()) {
        await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='expired',error_code='DEADLINE',updated_at=now() WHERE run_id=$1 AND state='pending'`,[runId]);
        await this.reconcileTerminalRun(tx,runId,'DEADLINE');
        return null;
      }
      if ((row.kind === 'auto' || row.auto_origin) && (!runtimeEnabled || !row.auto_enabled)) return null;
      const token = cryptoUuid();
      await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='sending',attempt_count=attempt_count+1,send_started_at=now(),lock_token=$3,updated_at=now()
        WHERE run_id=$1 AND page_index=$2`,[runId,pageIndex,token]);
      await tx.query(`UPDATE whatsapp_daily_digest_runs SET state='sending',updated_at=now() WHERE run_id=$1`,[runId]);
      await this.audit(tx,null,null,'page.intent',runId,{pageIndex,kind:row.kind,orderIds:row.order_ids},row.order_ids);
      return {token,destinationChatId:row.destination_chat_id,fileKey:row.file_key,sha256:row.sha256,expiresAt:row.expires_at};
    });
  }

  async settlePage(runId: string, pageIndex: number, token: string, result: {state:'sent'|'unknown'|'failed';providerMessageId?:string;errorCode?:string}) {
    return this.database.transaction(async tx => {
      await tx.query('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const page = (await tx.query<{state:string;lock_token:string|null;order_ids:number[]}>('SELECT state,lock_token,order_ids FROM whatsapp_daily_digest_pages WHERE run_id=$1 AND page_index=$2 FOR UPDATE',[runId,pageIndex])).rows[0];
      if (!page || page.state !== 'sending' || page.lock_token !== token) return false;
      await tx.query(`UPDATE whatsapp_daily_digest_pages SET state=$4,provider_message_id=$5,error_code=$6,sent_at=CASE WHEN $4='sent' THEN now() ELSE NULL END,lock_token=NULL,updated_at=now()
        WHERE run_id=$1 AND page_index=$2 AND lock_token=$3`,[runId,pageIndex,token,result.state,result.providerMessageId ?? null,result.errorCode ?? null]);
      const all = (await tx.query<{pending:number;sent:number;unknown:number;failed:number;cancelled:number;expired:number}>(`SELECT
        count(*) FILTER(WHERE state IN ('pending','sending'))::int pending,
        count(*) FILTER(WHERE state='sent')::int sent,
        count(*) FILTER(WHERE state='unknown')::int unknown,
        count(*) FILTER(WHERE state='failed')::int failed,
        count(*) FILTER(WHERE state='cancelled')::int cancelled,
        count(*) FILTER(WHERE state='expired')::int expired
        FROM whatsapp_daily_digest_pages WHERE run_id=$1`,[runId])).rows[0];
      const finalState = all?.unknown ? 'unknown' : all?.pending ? (result.state === 'failed' ? (all.sent ? 'partial' : 'failed') : 'sending')
        : all?.cancelled ? (all.sent ? 'partial' : 'cancelled') : all?.expired ? (all.sent ? 'partial' : 'expired')
        : all?.failed ? (all.sent ? 'partial' : 'failed') : 'sent';
      const finalReason = finalState==='unknown' ? 'PROVIDER_OUTCOME_UNKNOWN'
        : finalState==='cancelled' ? 'DISABLED' : finalState==='expired' ? 'IMAGE_EXPIRED'
        : finalState==='partial' ? (all?.cancelled ? 'DISABLED_PARTIAL' : all?.expired ? 'IMAGE_EXPIRED_PARTIAL' : result.errorCode ?? null)
        : result.errorCode ?? null;
      await tx.query('UPDATE whatsapp_daily_digest_runs SET state=$2,reason=$3,updated_at=now() WHERE run_id=$1',[runId,finalState,finalReason]);
      await this.audit(tx,null,null,`page.${result.state}`,runId,{pageIndex,errorCode:result.errorCode ?? null,orderIds:page.order_ids},page.order_ids);
      return true;
    });
  }

  async expireImagesAndPruneSnapshots(now = new Date()) {
    return this.database.transaction(async tx => {
      await tx.query('SELECT singleton_id FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='expired',error_code='IMAGE_EXPIRED',updated_at=now()
        WHERE expires_at <= $1 AND state IN ('pending','failed')`,[now]);
      await tx.query(`UPDATE whatsapp_daily_digest_runs r SET state='expired',reason='IMAGE_EXPIRED',updated_at=now()
        WHERE r.image_expires_at <= $1 AND r.state IN ('queued','partial','failed')
        AND NOT EXISTS (SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sending')`,[now]);
      await tx.query(`UPDATE whatsapp_daily_digest_runs r SET
        state=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'unknown'
                   WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'partial'
                   WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='cancelled') THEN 'cancelled' ELSE 'expired' END,
        reason=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'PROVIDER_OUTCOME_UNKNOWN'
                    WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'IMAGE_EXPIRED_PARTIAL'
                    WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='cancelled') THEN 'DISABLED' ELSE 'IMAGE_EXPIRED' END,
        updated_at=now()
        WHERE r.state IN ('queued','sending') AND NOT EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state IN ('pending','sending'))`);
      await tx.query(`UPDATE whatsapp_daily_digest_runs SET snapshot=NULL,snapshot_purged_at=now()
        WHERE created_at <= $1::timestamptz - interval '30 days' AND snapshot IS NOT NULL`,[now]);
      const pruneCandidates = await tx.query<{run_id:string}>(`SELECT r.run_id FROM whatsapp_daily_digest_runs r
        WHERE r.updated_at <= $1::timestamptz - interval '90 days'
          AND r.state IN ('sent','partial','failed','unknown','cancelled','expired','empty','skipped')
          AND NOT EXISTS (SELECT 1 FROM whatsapp_daily_digest_runs child WHERE child.parent_run_id=r.run_id)
          AND NOT EXISTS (SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sending')
        ORDER BY r.updated_at,r.run_id FOR UPDATE SKIP LOCKED LIMIT 100`,[now]);
      const pruneIds = pruneCandidates.rows.map(row=>row.run_id);
      if (pruneIds.length) {
        await tx.query('DELETE FROM whatsapp_daily_digest_pages WHERE run_id=ANY($1::uuid[])',[pruneIds]);
        await tx.query('DELETE FROM whatsapp_daily_digest_runs WHERE run_id=ANY($1::uuid[])',[pruneIds]);
      }
      const [refs, expired] = await Promise.all([
        tx.query<{file_key:string;expires_at:Date}>('SELECT file_key,expires_at FROM whatsapp_daily_digest_pages WHERE expires_at>$1 AND state NOT IN (\'expired\',\'cancelled\')',[now]),
        tx.query<{file_key:string}>('SELECT file_key FROM whatsapp_daily_digest_pages WHERE expires_at<=$1',[now]),
      ]);
      return { referenced: new Map(refs.rows.map(x=>[x.file_key,x.expires_at])), expiredKeys: expired.rows.map(x=>x.file_key), prunedRuns: pruneIds.length };
    });
  }

  async listQueuedRunIds(): Promise<string[]> {
    const rows = await this.database.query<{run_id:string}>(`SELECT run_id FROM whatsapp_daily_digest_runs r
      WHERE r.state IN ('queued','sending') ORDER BY r.created_at, r.run_id LIMIT 20`);
    return rows.rows.map(x=>x.run_id);
  }

  async hasAutomaticRun(businessDate: string): Promise<boolean> {
    const row=(await this.database.query('SELECT 1 FROM whatsapp_daily_digest_runs WHERE kind=\'auto\' AND business_date=$1::date LIMIT 1',[businessDate])).rows[0];
    return Boolean(row);
  }

  async failPendingPageBeforeIntent(runId: string,pageIndex: number,errorCode: string) {
    await this.database.transaction(async tx=>{
      await tx.query('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const page=(await tx.query<{state:string;order_ids:number[];preflight_attempt_count:number}>('SELECT state,order_ids,preflight_attempt_count FROM whatsapp_daily_digest_pages WHERE run_id=$1 AND page_index=$2 FOR UPDATE',[runId,pageIndex])).rows[0];
      if (!page || page.state!=='pending') return;
      const attempts=page.preflight_attempt_count+1;
      if (attempts < 3) {
        await tx.query(`UPDATE whatsapp_daily_digest_pages SET preflight_attempt_count=$3,next_attempt_at=now()+interval '1 minute',error_code=$4,updated_at=now() WHERE run_id=$1 AND page_index=$2`,[runId,pageIndex,attempts,errorCode]);
      } else {
        await tx.query(`UPDATE whatsapp_daily_digest_pages SET preflight_attempt_count=$3,state='failed',error_code=$4,updated_at=now() WHERE run_id=$1 AND page_index=$2`,[runId,pageIndex,attempts,errorCode]);
        await tx.query(`UPDATE whatsapp_daily_digest_runs r SET state=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'partial' ELSE 'failed' END,reason=$2,updated_at=now() WHERE r.run_id=$1 AND r.state IN ('queued','sending')`,[runId,errorCode]);
      }
      await this.audit(tx,null,null,'page.preflight_failed',runId,{pageIndex,errorCode,attemptCount:attempts,orderIds:page.order_ids},page.order_ids);
    });
  }

  async markStaleIntentsUnknown(staleAfterMs: number,now = new Date()) {
    await this.database.transaction(async tx=>{
      await tx.query('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const stale=(await tx.query<{run_id:string;page_index:number;order_ids:number[]}>('SELECT run_id,page_index,order_ids FROM whatsapp_daily_digest_pages WHERE state=\'sending\' AND send_started_at < $1',[new Date(now.getTime()-staleAfterMs)])).rows;
      for (const page of stale) {
        await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='unknown',error_code='PROCESS_LOST_AFTER_INTENT',lock_token=NULL,updated_at=now() WHERE run_id=$1 AND page_index=$2 AND state='sending'`,[page.run_id,page.page_index]);
        await tx.query(`UPDATE whatsapp_daily_digest_runs SET state='unknown',reason='PROVIDER_OUTCOME_UNKNOWN',updated_at=now() WHERE run_id=$1 AND state='sending'`,[page.run_id]);
        await this.audit(tx,null,null,'page.intent_stale',page.run_id,{pageIndex:page.page_index,orderIds:page.order_ids},page.order_ids);
      }
    });
  }

  async pagesForWorker(runId: string) {
    const rows = await this.database.query<{page_index:number;state:string;error_code:string|null;next_attempt_at:Date;preflight_attempt_count:number}>(
      `SELECT page_index,state,error_code,next_attempt_at,preflight_attempt_count FROM whatsapp_daily_digest_pages WHERE run_id=$1 ORDER BY page_index`,[runId]);
    return rows.rows;
  }

  async markRun(runId: string, state: DailyDigestRunState, reason: string | null) {
    await this.database.query('UPDATE whatsapp_daily_digest_runs SET state=$2,reason=$3,updated_at=now() WHERE run_id=$1',[runId,state,reason]);
  }

  async findByRetryKey(idempotencyKey: string) { return this.findByIdempotency(idempotencyKey); }

  /** Create one bounded automatic child after an exhausted preflight failure. Unknown pages are never eligible. */
  async createPolicyRetryAfterPreflightFailure(parentRunId: string): Promise<DailyDigestRunDetail | null> {
    return this.database.transaction(async tx=>{
      await tx.query('SELECT version,enabled FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const parent=(await tx.query<{run_id:string;business_date:string|Date;kind:string;auto_origin:boolean;parent_run_id:string|null;settings_version:number;destination_chat_id:string;catch_up_policy:string;deadline_at:Date|null;partial_policy:string;snapshot:DailyDigestSnapshot|null;renderer_version:string;order_count:number;total_area:string;retry_depth:number;image_expires_at:Date|null;state:string;reason:string|null}>(
        'SELECT * FROM whatsapp_daily_digest_runs WHERE run_id=$1 FOR UPDATE',[parentRunId])).rows[0];
      if (!parent || parent.partial_policy==='manual' || (!parent.auto_origin && parent.kind!=='auto')) return null;
      if (!['failed','partial'].includes(parent.state) || !['IMAGE_UNAVAILABLE','WHATSAPP_DAILY_DIGEST_STORE_BUSY','WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE','WHATSAPP_DAILY_DIGEST_IMAGE_MISSING','WHATSAPP_DAILY_DIGEST_IMAGE_INVALID'].includes(parent.reason ?? '')) return null;
      if (parent.reason==='PROVIDER_OUTCOME_UNKNOWN' || (parent.image_expires_at && parent.image_expires_at.getTime()<=Date.now()) || (parent.deadline_at && parent.deadline_at.getTime()<=Date.now())) return null;
      const setting=(await tx.query<{enabled:boolean}>('SELECT enabled FROM whatsapp_daily_digest_settings WHERE singleton_id=1')).rows[0];
      if (!setting?.enabled) return null;
      const lineage=await tx.query<{retry_count:number;has_active:boolean}>(`WITH RECURSIVE ancestors(run_id,parent_run_id) AS (
        SELECT run_id,parent_run_id FROM whatsapp_daily_digest_runs WHERE run_id=$1
        UNION ALL SELECT r.run_id,r.parent_run_id FROM whatsapp_daily_digest_runs r JOIN ancestors a ON r.run_id=a.parent_run_id
      ), root AS (SELECT run_id FROM ancestors WHERE parent_run_id IS NULL LIMIT 1), descendants AS (
        SELECT r.run_id,r.state,r.kind FROM whatsapp_daily_digest_runs r JOIN root ON r.run_id=root.run_id
        UNION ALL SELECT child.run_id,child.state,child.kind FROM whatsapp_daily_digest_runs child JOIN descendants d ON child.parent_run_id=d.run_id
      ) SELECT count(*) FILTER(WHERE kind='retry')::int retry_count,bool_or(state IN ('queued','sending')) has_active FROM descendants`,[parentRunId]);
      if (Number(lineage.rows[0]?.retry_count??0)>=3 || lineage.rows[0]?.has_active) return null;
      const pages=(await tx.query<{page_index:number;order_ids:number[];file_key:string;sha256:string;size_bytes:number;expires_at:Date;state:string}>('SELECT * FROM whatsapp_daily_digest_pages WHERE run_id=$1 ORDER BY page_index FOR UPDATE',[parentRunId])).rows;
      if (!pages.length || pages.some(page=>page.state==='unknown'||page.state==='sending')) return null;
      const selected=parent.partial_policy==='repeat_all'?pages:pages.filter(page=>page.state==='pending'||page.state==='failed');
      if (!selected.length || selected.some(page=>page.expires_at.getTime()<=Date.now())) return null;
      const runId=cryptoUuid();
      const idempotencyKey=cryptoUuid();
      const requestDigest=digest({kind:'policy_retry',parentRunId,mode:parent.partial_policy,preflight:true});
      await tx.query(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,parent_run_id,auto_origin,idempotency_key,request_digest,settings_version,destination_chat_id,
        catch_up_policy,deadline_at,partial_policy,snapshot,renderer_version,order_count,total_area,state,reason,retry_depth,image_expires_at)
        VALUES($1,$2::date,'retry',$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'queued',NULL,$15,$16)`,
        [runId,parent.business_date,parentRunId,idempotencyKey,requestDigest,parent.settings_version,parent.destination_chat_id,parent.catch_up_policy,parent.deadline_at,parent.partial_policy,
          parent.snapshot?JSON.stringify(parent.snapshot):null,parent.renderer_version,parent.order_count,parent.total_area,parent.retry_depth+1,parent.image_expires_at]);
      for (const page of selected) await tx.query(`INSERT INTO whatsapp_daily_digest_pages(run_id,page_index,order_ids,file_key,sha256,size_bytes,expires_at,state)
        VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,'pending')`,[runId,page.page_index,JSON.stringify(page.order_ids),page.file_key,page.sha256,page.size_bytes,page.expires_at]);
      await tx.query(`UPDATE whatsapp_daily_digest_pages SET state='cancelled',error_code='SUPERSEDED_BY_POLICY_RETRY',updated_at=now() WHERE run_id=$1 AND state='pending'`,[parentRunId]);
      await this.audit(tx,null,null,'run.policy_retry',runId,{parentRunId,policy:parent.partial_policy,pageCount:selected.length,orderIds:selected.flatMap(page=>page.order_ids)},selected.flatMap(page=>page.order_ids));
      return this.getRunIn(tx,runId);
    });
  }

  async createRetry(parentRunId: string, input: {idempotencyKey:string;mode:'remaining'|'all';duplicateRiskConfirmed:boolean;actor:CurrentUser;requestId:string;runId:string}) {
    return this.database.transaction(async tx => {
      await tx.query('SELECT version FROM whatsapp_daily_digest_settings WHERE singleton_id=1 FOR UPDATE');
      const requestDigest=digest({kind:'retry',parentRunId,mode:input.mode,duplicateRiskConfirmed:input.duplicateRiskConfirmed,actorId:input.actor.id});
      const prior=(await tx.query<{run_id:string;request_digest:string}>('SELECT run_id,request_digest FROM whatsapp_daily_digest_runs WHERE idempotency_key=$1 FOR UPDATE',[input.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest!==requestDigest) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_IDEMPOTENCY_CONFLICT','Этот ключ уже использован для другой команды');
        return this.getRunIn(tx,prior.run_id);
      }
      const parent = (await tx.query<{run_id:string;business_date:string|Date;kind:string;auto_origin:boolean;parent_run_id:string|null;settings_version:number;destination_chat_id:string;catch_up_policy:string;deadline_at:Date|null;partial_policy:string;snapshot:DailyDigestSnapshot|null;renderer_version:string;order_count:number;total_area:string;retry_depth:number;image_expires_at:Date|null;state:string}>(
        'SELECT * FROM whatsapp_daily_digest_runs WHERE run_id=$1 FOR UPDATE',[parentRunId])).rows[0];
      if (!parent) throw new ApiError(404,'WHATSAPP_DAILY_DIGEST_RUN_NOT_FOUND','Запуск рассылки не найден');
      if (parent.retry_depth >= 3) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_RETRY_LIMIT','Достигнут предел повторных запусков');
      if (['queued','sending'].includes(parent.state)) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_RETRY_ACTIVE','Дождитесь завершения текущего запуска');
      if (parent.image_expires_at && parent.image_expires_at.getTime() <= Date.now()) throw new ApiError(410,'WHATSAPP_DAILY_DIGEST_IMAGE_EXPIRED','Срок хранения изображений истёк');
      if (parent.deadline_at && parent.deadline_at.getTime() <= Date.now()) throw new ApiError(410,'WHATSAPP_DAILY_DIGEST_DEADLINE_PASSED','Срок отправки этого запуска истёк');
      const lineage = await tx.query<{retry_count:number;has_active:boolean}>(`WITH RECURSIVE ancestors(run_id,parent_run_id) AS (
        SELECT run_id,parent_run_id FROM whatsapp_daily_digest_runs WHERE run_id=$1
        UNION ALL SELECT r.run_id,r.parent_run_id FROM whatsapp_daily_digest_runs r JOIN ancestors a ON r.run_id=a.parent_run_id
      ), root AS (SELECT run_id FROM ancestors WHERE parent_run_id IS NULL LIMIT 1), descendants AS (
        SELECT r.run_id,r.state,r.kind FROM whatsapp_daily_digest_runs r JOIN root ON r.run_id=root.run_id
        UNION ALL SELECT child.run_id,child.state,child.kind FROM whatsapp_daily_digest_runs child JOIN descendants d ON child.parent_run_id=d.run_id
      ) SELECT count(*) FILTER(WHERE kind='retry')::int retry_count,bool_or(state IN ('queued','sending')) has_active FROM descendants`,[parentRunId]);
      if (Number(lineage.rows[0]?.retry_count ?? 0) >= 3 || lineage.rows[0]?.has_active) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_RETRY_LIMIT','Повторная отправка уже создана или достигнут предел повторов');
      const rows = (await tx.query<{page_index:number;order_ids:number[];file_key:string;sha256:string;size_bytes:number;expires_at:Date;state:string;attempt_count:number;provider_message_id:string|null;error_code:string|null;sent_at:Date|null}>(
        'SELECT * FROM whatsapp_daily_digest_pages WHERE run_id=$1 ORDER BY page_index FOR UPDATE',[parentRunId])).rows;
      if (!rows.length) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_RETRY_NOT_AVAILABLE','В запуске нет страниц для повтора');
      const hasUncertain = rows.some(x=>x.state==='unknown');
      if ((input.mode==='all' || hasUncertain) && !input.duplicateRiskConfirmed) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_DUPLICATE_CONFIRMATION_REQUIRED','Повтор может создать дубликаты; подтвердите риск');
      const selected = input.mode==='all' ? rows : rows.filter(x=>x.state==='pending'||x.state==='failed'||x.state==='unknown'||(x.state==='cancelled'&&x.error_code==='DISABLED'));
      if (!selected.length) throw new ApiError(409,'WHATSAPP_DAILY_DIGEST_RETRY_NOT_AVAILABLE','Нет страниц для повтора');
      const retryDepth = parent.retry_depth+1;
      await tx.query(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,parent_run_id,auto_origin,idempotency_key,request_digest,settings_version,destination_chat_id,
        catch_up_policy,deadline_at,partial_policy,snapshot,renderer_version,order_count,total_area,state,actor_user_id,request_id,retry_depth,image_expires_at)
        VALUES($1,$2::date,'retry',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,'queued',$16,$17,$18,$19)`,
        [input.runId,parent.business_date,parentRunId,false,input.idempotencyKey,requestDigest,parent.settings_version,parent.destination_chat_id,parent.catch_up_policy,parent.deadline_at,parent.partial_policy,
          parent.snapshot?JSON.stringify(parent.snapshot):null,parent.renderer_version,parent.order_count,parent.total_area,input.actor.id,input.requestId,retryDepth,parent.image_expires_at]);
      for (const row of selected) {
        if (row.expires_at.getTime() <= Date.now()) throw new ApiError(410,'WHATSAPP_DAILY_DIGEST_IMAGE_EXPIRED','Срок хранения изображения истёк');
        await tx.query(`INSERT INTO whatsapp_daily_digest_pages(run_id,page_index,order_ids,file_key,sha256,size_bytes,expires_at,state)
          VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,'pending')`,[input.runId,row.page_index,JSON.stringify(row.order_ids),row.file_key,row.sha256,row.size_bytes,row.expires_at]);
      }
      await this.audit(tx,input.actor,input.requestId,'run.retry',input.runId,{parentRunId,mode:input.mode,pageCount:selected.length,duplicateRiskConfirmed:input.duplicateRiskConfirmed,orderIds:selected.flatMap(page=>page.order_ids)},selected.flatMap(page=>page.order_ids));
      return this.getRunIn(tx,input.runId);
    });
  }

  private async getRunIn(client: Pick<DatabaseService,'query'> | TransactionClient, runId: string): Promise<DailyDigestRunDetail> {
    const run = (await client.query<RunRow>(`${runSelect()} WHERE r.run_id=$1`,[runId])).rows[0];
    if (!run) throw new ApiError(404,'WHATSAPP_DAILY_DIGEST_RUN_NOT_FOUND','Запуск рассылки не найден');
    const pages = await client.query<PageRow>(`SELECT p.*, (p.expires_at>now() AND r.image_expires_at>now()) AS image_available
      FROM whatsapp_daily_digest_pages p JOIN whatsapp_daily_digest_runs r USING(run_id) WHERE p.run_id=$1 ORDER BY p.page_index`,[runId]);
    return {run:mapRun(run),pages:pages.rows.map(mapPage)};
  }

  private async reconcileTerminalRun(tx: TransactionClient, runId: string, reason: string) {
    await tx.query(`UPDATE whatsapp_daily_digest_runs r SET
      state=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'unknown'
                 WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN 'partial'
                 WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='cancelled') THEN 'cancelled'
                 WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='failed') THEN 'failed' ELSE 'expired' END,
      reason=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='unknown') THEN 'PROVIDER_OUTCOME_UNKNOWN'
                  WHEN EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') THEN $2 || '_PARTIAL' ELSE $2 END,
      updated_at=now()
      WHERE r.run_id=$1 AND r.state IN ('queued','sending')
        AND NOT EXISTS(SELECT 1 FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state IN ('pending','sending'))`,[runId,reason]);
  }

  private async audit(tx: TransactionClient, actor: CurrentUser | undefined | null, requestId: string | null | undefined, action: string, entityId: string | null, metadata: Record<string, unknown>, orderIds: number[] = []) {
    await auditService.record(tx, {
      event: `whatsapp.daily_digest.${action}`, entityType: 'whatsapp_daily_digest', entityId: entityId ?? 'settings',
      actorUserId: actor?.id ?? null, actorUsername: actor?.username ?? null, actorRole: actor?.role ?? null,
      requestId: requestId ?? 'whatsapp-daily-digest-system', source: 'erp_whatsapp_daily_digest',
      metadata,
      relatedEntities: orderIds.map(entityId => ({ entityType: 'order', entityId })),
    });
  }
}

function runSelect() { return `SELECT r.run_id,r.business_date,r.kind,r.parent_run_id,r.state,r.reason,r.order_count,r.total_area,r.destination_chat_id,r.created_at,r.updated_at,r.image_expires_at,
  (SELECT count(*)::int FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id) page_count,
  (SELECT count(*)::int FROM whatsapp_daily_digest_pages p WHERE p.run_id=r.run_id AND p.state='sent') sent_page_count
  FROM whatsapp_daily_digest_runs r`; }
function mapSettings(row: SettingsRow) {
  return {version:Number(row.version),enabled:row.enabled,groupChatId:row.group_chat_id,sendTime:String(row.send_time).slice(0,5),timeZone:'Asia/Almaty' as const,
    cardsPerMessage:Number(row.cards_per_message) as 1|2,
    catchUpPolicy:row.catch_up_policy as DailyDigestSettingsInput['catchUpPolicy'],catchUpDeadline:String(row.catch_up_deadline).slice(0,5),partialPolicy:row.partial_policy as DailyDigestSettingsInput['partialPolicy']};
}
function mapRun(row: RunRow): DailyDigestRun {
  const date = row.business_date instanceof Date ? row.business_date.toISOString().slice(0,10) : String(row.business_date).slice(0,10);
  return {id:row.run_id,businessDate:date,kind:row.kind,parentRunId:row.parent_run_id,state:row.state,reason:row.reason,
    orderCount:Number(row.order_count),totalArea:Number(row.total_area),pageCount:Number(row.page_count ?? 0),sentPageCount:Number(row.sent_page_count ?? 0),
    destinationMasked:maskDestination(row.destination_chat_id),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),expiresAt:row.image_expires_at?.toISOString() ?? null};
}
function mapPage(row: PageRow): DailyDigestPage {
  return {pageIndex:Number(row.page_index),orderIds:Array.isArray(row.order_ids)?row.order_ids:[],state:row.state,attemptCount:Number(row.attempt_count),providerMessageId:row.provider_message_id,
    errorCode:row.error_code,sentAt:row.sent_at?.toISOString() ?? null,imageAvailable:Boolean(row.image_available),expiresAt:row.expires_at.toISOString()};
}
function maskDestination(value: string) { return value.replace(/^(\d{2})[\d-]+(@g\.us)$/, '$1***$2'); }
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && (error as {code:string}).code === '23505'); }
function cryptoUuid() { return require('node:crypto').randomUUID() as string; }
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function dailyDigestRequestDigest(value: unknown) { return digest(value); }
