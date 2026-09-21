import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { TransactionClient, DatabaseClient } from '../../database/database.types';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName } from '../../permissions/permissions';
import { rolePolicyForUser } from '../../permissions/policies/scope';
import { buildOrderReadScopePredicate, orderAssignmentExistsSql } from '../../permissions/policies/order-read-scope-sql';
import { evaluateStatusAutomation, isStatusAutomationEnabled } from '../status-automation/application/status-automation-runtime';
import { listEnabledRulesForEvent, loadOrderAutomationState } from '../status-automation/adapters/pg-status-automation-repository';
import { selectApplicableRules } from '../status-automation/domain/status-automation-evaluator';
import type { StatusAutomationEvent } from '../status-automation/application/status-automation.types';
import { digest, extractReferences, matchRules, messageKey, parseConfiguration, parseWahaGroup, type InboundMessage, type Resolver, type SignalConfiguration } from './inbound-signals.domain';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(150).default(''), channel: z.string().max(40).optional(),
  source: z.string().max(64).optional(), signal: z.string().max(64).optional(),
  state: z.enum(['needs_review','pending','processing','retry_wait','succeeded','no_action','failed','dismissed']).optional(),
  orderId: z.coerce.number().int().positive().optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  diagnostic: z.enum(['true','false']).default('false'),
});
const commandSchema = z.object({
  version: z.number().int().positive(), orderId: z.number().int().positive().optional(),
  previewHash: z.string().length(64).optional(),
  reason: z.enum(['false_match','irrelevant','duplicate','other']).optional(),
}).strict();
type Occurrence = {
  id: string; message_id: string; signal_code: string; signal_name: string; order_id: string | null;
  state: string; version: number; rule_codes: string[]; processing_request_id: string;
  attempt_count: number; lock_token: string | null; source_code: string; config_version: number; resolved_by: string | null; execution_guard: string | null;
};
type ConfigRow = { version: number; document: Omit<SignalConfiguration, 'version'>; source_activation: Record<string, string> };
function invalid(): never { throw new ApiError(422, 'SIGNAL_INPUT_INVALID', 'Проверьте поля запроса'); }
function conflict(): never { throw new ApiError(409, 'SIGNAL_VERSION_CONFLICT', 'Данные изменились. Обновите карточку и предпросмотр.'); }
function requirePermission(actor: CurrentUser, permission: PermissionName) {
  if (!actor.permissions.includes(permission)) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав');
}
function scopeSql(actor: CurrentUser, params: unknown[]): string {
  if (!actor.permissions.includes('orders.view')) return 'FALSE';
  const scope = rolePolicyForUser(actor).orders.view;
  const index = scope === 'own' || scope === 'assigned' ? params.push(actor.id) : null;
  return buildOrderReadScopePredicate(scope, index, index === null ? 'FALSE' : orderAssignmentExistsSql('o', index), 'o');
}

@Injectable()
export class InboundSignalsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private cleanupAt = 0;
  private readonly logger = new Logger(InboundSignalsService.name);
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConfigService) private readonly env: ConfigService<BackendEnv, true>) {}

  enabled() { return this.env.get('BACKEND_ENABLE_INBOUND_SIGNALS', { infer: true }); }
  private requireEnabled() {
    if (!this.enabled()) throw new ApiError(503, 'INBOUND_SIGNALS_DISABLED', 'Обработка входящих сигналов ещё не включена');
  }
  onModuleInit() {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(); }, 10000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.cleanupAt > 3600000) { await this.cleanup(); this.cleanupAt = Date.now(); }
      if (this.env.get('BACKEND_INBOUND_SIGNALS_RELAY_OWNER', { infer: true }) === 'in_process'
        && isStatusAutomationEnabled()) await this.processBatch();
    } catch {
      // Never log SQL/driver errors: they may contain message contents in parameters.
      this.logger.error('INBOUND_SIGNALS_TICK_FAILED');
    } finally { this.running = false; }
  }
  private async config(client: DatabaseClient = this.db, lock = false): Promise<ConfigRow> {
    const result = await client.query<ConfigRow>(`SELECT version,document,source_activation FROM message_processing_configuration WHERE id=true${lock ? ' FOR UPDATE' : ''}`);
    if (!result.rows[0]) throw new ApiError(503, 'SIGNAL_STORAGE_UNAVAILABLE', 'Хранилище сигналов не подготовлено');
    return result.rows[0];
  }
  async getConfiguration(actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.manage_config');
    const row = await this.config();
    return { ...row.document, version: row.version };
  }
  async saveConfiguration(body: unknown, actor: CurrentUser, requestId: string) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.manage_config');
    const next = parseConfiguration(body);
    return this.db.transaction(async tx => {
      const old = await this.config(tx, true);
      if (old.version !== next.version) conflict();
      const activation: Record<string, string> = {};
      for (const source of next.sources) {
        const prev = old.document.sources.find(s => s.code === source.code);
        const same = prev?.enabled && source.enabled && prev.chatId === source.chatId && prev.connection === source.connection;
        activation[source.code] = same && old.source_activation[source.code] ? old.source_activation[source.code] : new Date().toISOString();
      }
      const { version, ...document } = next;
      await tx.query('UPDATE message_processing_configuration SET version=version+1,document=$1,source_activation=$2,updated_at=now() WHERE id=true', [document, activation]);
      await this.audit(tx, 'message_signals.configuration_updated', 'configuration', actor, requestId, { previousVersion: version, version: version + 1 });
      return { ...document, version: version + 1 };
    });
  }
  async testTemplate(body: unknown, actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.manage_config');
    const parsed = z.object({ configuration: configurationSchemaForTest(), text: z.string().max(16000), source: z.string().max(64) }).safeParse(body);
    if (!parsed.success) invalid();
    const config = parseConfiguration(parsed.data.configuration);
    return matchRules(parsed.data.text, parsed.data.source, config).map(rule => ({
      ruleCode: rule.code, signalCode: rule.signalCode,
      references: extractReferences(parsed.data.text, config.resolvers.find(r => r.code === rule.resolverCode)!),
    }));
  }
  async acceptWaha(body: unknown, session: string, requestId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const message = parseWahaGroup(body, session);
    if (!message) return false;
    const result = await this.accept(message, requestId);
    return !('ignored' in result);
  }
  async accept(message: InboundMessage, requestId: string) {
    this.requireEnabled();
    return this.db.transaction(async tx => {
      // Snapshot rules and sources through commit; configuration updates serialize with intake.
      const row = await this.config(tx, true);
      const source = row.document.sources.find(s => s.enabled && s.channel === message.channel && s.connection === message.connection && s.chatId === message.chatId);
      if (!source || message.sentAt.getTime() < Date.parse(row.source_activation[source.code] ?? '')
        || !row.source_activation[source.code] || message.sentAt.getTime() > Date.now() + 300000) return { ignored: true };
      const key = messageKey(message);
      const receipt = await tx.query('INSERT INTO inbound_message_receipts(message_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_key', [key]);
      if (!receipt.rowCount) return { duplicate: true };
      const config = { ...row.document, version: row.version };
      const rules = matchRules(message.text, source.code, config);
      const saved = await tx.query<{ id: string }>(`INSERT INTO inbound_messages(message_key,channel,source_code,source_name,sender,message_text,sent_at,config_version,request_id,matched)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [key, message.channel, source.code, source.name, message.sender, message.text, message.sentAt, row.version, requestId, rules.length > 0]);
      const messageId = saved.rows[0].id;
      for (const signalCode of [...new Set(rules.map(r => r.signalCode))]) {
        const signalRules = rules.filter(r => r.signalCode === signalCode);
        const resolved = await Promise.all(signalRules.map(async rule => {
          const resolver = config.resolvers.find(r => r.code === rule.resolverCode)!;
          return this.resolveReferences(tx, extractReferences(message.text, resolver), resolver);
        }));
        const targets = [...new Set(resolved.flat())];
        const orderId = targets.length === 1 && resolved.every(ids => ids.length === 1) ? targets[0] : null;
        const reason = orderId ? null : targets.length > 1 ? 'ambiguous_reference' : 'reference_not_found';
        const savedSignal = await tx.query<{ id: string }>(`INSERT INTO inbound_signal_occurrences(message_id,signal_code,signal_name,rule_codes,order_id,state,reason_code,processing_request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [messageId, signalCode, config.signals.find(s => s.code === signalCode)!.name, JSON.stringify(signalRules.map(r => r.code)), orderId,
          orderId ? 'pending' : 'needs_review', reason, randomUUID()]);
        await this.step(tx, savedSignal.rows[0].id, 'signal_detected', null, { configVersion: row.version, ruleCodes: signalRules.map(r => r.code) });
        await this.step(tx, savedSignal.rows[0].id, orderId ? 'order_resolved' : reason!, null, orderId ? { orderId } : {});
      }
      return { accepted: true, messageId };
    });
  }
  private async resolveReferences(tx: TransactionClient, references: string[], resolver: Resolver): Promise<string[]> {
    if (!references.length || references.length > 20) return [];
    // Every extracted reference must resolve uniquely to the SAME order.
    if (references.length > 1) {
      const resolved = await Promise.all(references.map(reference => this.resolveReferences(tx, [reference], resolver)));
      if (resolved.some(ids => ids.length !== 1)) return [];
      return [...new Set(resolved.flat())];
    }
    // Explicit server catalog; no SQL identifiers supplied by configuration.
    const predicate = resolver.target === 'order_id' ? 'o.order_id::text = ANY($1::text[])'
      : resolver.target === 'order_name' ? 'lower(o.order_name) = ANY($1::text[])'
      : resolver.target === 'cut_id' ? `EXISTS(SELECT 1 FROM cut_job_item i WHERE i.order_id=o.order_id AND i.is_active=true AND i.cut_job_id::text=ANY($1::text[]))`
      : `EXISTS(SELECT 1 FROM projects p WHERE p.project_id=o.project_id AND p.delete_flag=false AND lower(p.code::text)=ANY($1::text[]))`;
    const rows = await tx.query<{ order_id: string }>(`SELECT o.order_id FROM orders o WHERE o.delete_flag=false AND ${predicate} ORDER BY o.order_id LIMIT 21`, [references]);
    return rows.rows.map(r => String(r.order_id));
  }
  async list(query: unknown, actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.view');
    const parsed = listSchema.safeParse(query); if (!parsed.success) invalid();
    const q = parsed.data;
    const params: unknown[] = [];
    const scope = scopeSql(actor, params);
    const canResolve = actor.permissions.includes('message_signals.resolve');
    const where = ['m.expires_at>now()', `((s.order_id IS NOT NULL AND o.delete_flag=false AND ${scope})${canResolve ? ' OR s.order_id IS NULL' : ''})`];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.diagnostic !== 'true') where.push('s.id IS NOT NULL');
    if (q.q) add('(m.message_text ILIKE ?)', `%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
    if (q.channel) add('m.channel=?', q.channel);
    if (q.source) add('m.source_code=?', q.source);
    if (q.signal) add('s.signal_code=?', q.signal);
    if (q.state) add('s.state=?', q.state);
    if (q.orderId) add('s.order_id=?', q.orderId);
    if (q.from) add('m.received_at>=?::timestamptz', q.from);
    if (q.to) add('m.received_at<=?::timestamptz', q.to);
    const base = `FROM inbound_messages m LEFT JOIN inbound_signal_occurrences s ON s.message_id=m.id LEFT JOIN orders o ON o.order_id=s.order_id WHERE ${where.join(' AND ')}`;
    const count = await this.db.query<{ total: string; attention: string; completed: string }>(`SELECT count(*) AS total,count(*) FILTER(WHERE s.state IN ('needs_review','failed')) AS attention,count(*) FILTER(WHERE s.state IN ('succeeded','no_action')) AS completed ${base}`, params);
    const limit = params.push(q.pageSize), offset = params.push((q.page-1)*q.pageSize);
    const rows = await this.db.query(`SELECT m.id AS message_id,m.channel,m.source_name,m.source_code,m.sender,m.message_text,m.sent_at,m.received_at,
      s.id,s.signal_code,s.signal_name,s.state,s.reason_code,s.order_id,s.version,s.updated_at,o.order_name ${base}
      ORDER BY m.received_at DESC,m.id DESC,s.id DESC LIMIT $${limit} OFFSET $${offset}`, params);
    return { items: rows.rows, total: Number(count.rows[0].total), attention: Number(count.rows[0].attention), completed: Number(count.rows[0].completed),
      page: q.page, pageSize: q.pageSize, relayEnabled: this.env.get('BACKEND_INBOUND_SIGNALS_RELAY_OWNER', { infer: true }) === 'in_process',
      automationEnabled: isStatusAutomationEnabled() };
  }
  private async occurrence(client: DatabaseClient, id: string, actor?: CurrentUser, lock = false): Promise<Occurrence> {
    const params: unknown[] = [id];
    const scope = actor ? scopeSql(actor, params) : 'TRUE';
    const allowUnresolved = !actor || actor.permissions.includes('message_signals.resolve');
    const result = await client.query<Occurrence>(`SELECT s.*,m.source_code,m.config_version FROM inbound_signal_occurrences s
      JOIN inbound_messages m ON m.id=s.message_id LEFT JOIN orders o ON o.order_id=s.order_id
      WHERE s.id=$1 AND m.expires_at>now() AND ((s.order_id IS NOT NULL AND o.delete_flag=false AND ${scope})${allowUnresolved ? ' OR s.order_id IS NULL' : ''})${lock ? ' FOR UPDATE OF s' : ''}`, params);
    if (!result.rows[0]) throw new ApiError(404, 'SIGNAL_NOT_FOUND', 'Сигнал не найден или недоступен');
    return result.rows[0];
  }
  async detail(id: string, actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.view');
    const signal = await this.occurrence(this.db, id, actor);
    const message = await this.db.query('SELECT channel,source_name,sender,message_text,sent_at,received_at FROM inbound_messages WHERE id=$1', [signal.message_id]);
    const steps = await this.db.query('SELECT occurred_at,event_code,actor_user_id,details FROM inbound_signal_steps WHERE signal_id=$1 ORDER BY id', [id]);
    const audits = await this.db.query(`SELECT event,created_at AS occurred_at,metadata_json->>'ruleName' AS rule_name,metadata_json->>'reason' AS reason,
      metadata_json->>'actionType' AS action_type,metadata_json->>'targetStatusId' AS target_status_id
      FROM audit_log WHERE request_id=$1 AND related_order_id=$2 AND event IN ('status_automation.rule_applied','status_automation.rule_skipped') ORDER BY created_at`, [signal.processing_request_id, signal.order_id]);
    return { id: signal.id, version: signal.version, signalCode: signal.signal_code, signalName: signal.signal_name, orderId: signal.order_id,
      state: signal.state, message: message.rows[0], steps: actor.permissions.includes('message_signals.technical') ? steps.rows
        : steps.rows.map(step => ({ ...step, details: { reason: step.details.reason ?? null, orderId: step.details.orderId ?? null } })), actions: audits.rows,
      ...(actor.permissions.includes('message_signals.technical') ? { technical: { requestId: signal.processing_request_id,
        configVersion: signal.config_version, ruleCodes: signal.rule_codes, attemptCount: signal.attempt_count } } : {}) };
  }
  async orderOptions(search: string, actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.resolve');
    const params: unknown[] = [`%${search.slice(0,100).replace(/[\\%_]/g, '\\$&')}%`];
    const scope = scopeSql(actor, params);
    const result = await this.db.query(`SELECT o.order_id AS id,o.order_name AS name FROM orders o WHERE o.delete_flag=false AND ${scope}
      AND (o.order_name ILIKE $1 OR o.order_id::text ILIKE $1) ORDER BY o.order_id DESC LIMIT 30`, params);
    return result.rows;
  }
  private async preview(tx: TransactionClient, signal: Occurrence, orderId: number, actor: CurrentUser) {
    const params: unknown[] = [orderId];
    const scope = scopeSql(actor, params);
    const visible = await tx.query(`SELECT o.order_id,o.order_name FROM orders o WHERE o.order_id=$1 AND o.delete_flag=false AND ${scope} FOR UPDATE`, params);
    if (!visible.rowCount) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден или недоступен');
    const state = await loadOrderAutomationState(tx, orderId);
    if (!state) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    const rules = await listEnabledRulesForEvent(tx, 'message.signal_detected');
    const config = await this.config(tx);
    const result = selectApplicableRules(rules, state, this.event(signal, orderId));
    const executionGuard = digest([orderId, state, rules, config.version]);
    const hash = digest([signal.id, signal.version, executionGuard]);
    return { previewHash: hash, executionGuard, order: visible.rows[0], applied: result.applied.map(r => ({ id: r.id, name: r.name, actionType: r.actionType, targetStatusId: r.targetStatusId })),
      skipped: result.skipped, automationEnabled: isStatusAutomationEnabled(), version: signal.version };
  }
  async previewResolve(id: string, body: unknown, actor: CurrentUser) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.resolve');
    const parsed = commandSchema.safeParse(body); if (!parsed.success || !parsed.data.orderId) invalid();
    const { orderId, version } = parsed.data;
    return this.db.transaction(async tx => {
      const signal = await this.occurrence(tx, id, actor);
      if (signal.version !== version || signal.state !== 'needs_review') conflict();
      return this.preview(tx, signal, orderId!, actor);
    });
  }
  async command(id: string, action: 'resolve'|'dismiss'|'retry', body: unknown, key: string | undefined, actor: CurrentUser, requestId: string) {
    this.requireEnabled(); requirePermission(actor, 'message_signals.resolve');
    const parsed = commandSchema.safeParse(body); if (!parsed.success || !key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) invalid();
    const input = parsed.data, requestHash = digest([id, action, input]);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`inbound-command:${key}`]);
      const receipt = await tx.query<{ actor_user_id: string; request_hash: string; response: object }>('SELECT * FROM inbound_signal_commands WHERE idempotency_key=$1', [key]);
      if (receipt.rows[0]) {
        if (String(receipt.rows[0].actor_user_id) !== actor.id || receipt.rows[0].request_hash !== requestHash) conflict();
        return receipt.rows[0].response;
      }
      const signal = await this.occurrence(tx, id, actor, true);
      if (signal.version !== input.version) conflict();
      let orderId = signal.order_id, next = 'pending';
      let executionGuard: string | null = signal.execution_guard;
      if (action === 'resolve') {
        if (signal.state !== 'needs_review' || !input.orderId || !input.previewHash) conflict();
        const preview = await this.preview(tx, signal, input.orderId, actor);
        if (preview.previewHash !== input.previewHash) conflict();
        orderId = String(input.orderId);
        executionGuard = preview.executionGuard;
      } else if (action === 'dismiss') {
        if (!['needs_review','failed'].includes(signal.state) || !input.reason) conflict();
        next = 'dismissed';
        executionGuard = null;
      } else if (signal.state !== 'failed' || !signal.order_id) conflict();
      await tx.query(`UPDATE inbound_signal_occurrences SET order_id=$2,state=$3,reason_code=$4,version=version+1,resolved_by=$5,execution_guard=$6,
        attempt_count=0,next_attempt_at=now(),locked_at=NULL,lock_token=NULL,updated_at=now(),finished_at=CASE WHEN $3='dismissed' THEN now() ELSE NULL END WHERE id=$1`,
      [id, orderId, next, action === 'dismiss' ? input.reason : null, actor.id, executionGuard]);
      await this.step(tx,id,action,actor.id,{ orderId, ...(action === 'dismiss' ? { reason: input.reason } : {}) });
      await this.audit(tx,`message_signals.${action}`,id,actor,requestId,{ orderId, state: next });
      const response = { id, state: next, version: signal.version + 1 };
      await tx.query('INSERT INTO inbound_signal_commands(idempotency_key,actor_user_id,request_hash,response) VALUES($1,$2,$3,$4)', [key,actor.id,requestHash,response]);
      return response;
    });
  }
  private event(signal: Occurrence, orderId: number): StatusAutomationEvent {
    return { eventType: 'message.signal_detected', origin: 'external', orderId, signalCode: signal.signal_code,
      signalOccurrenceId: signal.id, actor: { id: null, role: null, username: 'Обработка входящих сигналов' },
      requestId: signal.processing_request_id, sourceIdempotencyKey: `inbound-signal:${signal.id}` };
  }
  async processBatch() {
    this.requireEnabled();
    if (this.env.get('BACKEND_INBOUND_SIGNALS_RELAY_OWNER', { infer: true }) !== 'in_process' || !isStatusAutomationEnabled()) return;
    await this.db.query(`UPDATE inbound_signal_occurrences SET state=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'retry_wait' END,
      lock_token=NULL,locked_at=NULL,reason_code='worker_interrupted',updated_at=now(),version=version+1
      WHERE state='processing' AND locked_at<now()-interval '5 minutes'`);
    for (let i=0;i<10;i++) {
      const token = randomUUID();
      const claimed = await this.db.query<{ id: string }>(`WITH candidate AS (
        SELECT s.id FROM inbound_signal_occurrences s JOIN inbound_messages m ON m.id=s.message_id
        WHERE s.state IN ('pending','retry_wait') AND s.next_attempt_at<=now() AND s.attempt_count<5 AND m.expires_at>now()
        ORDER BY s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1)
        UPDATE inbound_signal_occurrences s SET state='processing',lock_token=$1,locked_at=now(),attempt_count=attempt_count+1,version=version+1
        FROM candidate c WHERE s.id=c.id RETURNING s.id`, [token]);
      const id = claimed.rows[0]?.id; if (!id) break;
      try {
        await this.db.transaction(async tx => {
          const rows = await tx.query<Occurrence>(`SELECT s.*,m.source_code,m.config_version FROM inbound_signal_occurrences s JOIN inbound_messages m ON m.id=s.message_id
            WHERE s.id=$1 AND s.lock_token=$2 AND s.state='processing' AND m.expires_at>now() FOR UPDATE OF s`, [id,token]);
          const signal = rows.rows[0]; if (!signal) return;
          await tx.query('SELECT id FROM message_processing_configuration WHERE id=true FOR SHARE');
          await tx.query('LOCK TABLE status_automation_rules IN SHARE MODE');
          const config = await this.config(tx);
          const active = config.document.sources.some(s => s.code === signal.source_code && s.enabled)
            && config.document.rules.some(r => signal.rule_codes.includes(r.code) && r.enabled && r.signalCode === signal.signal_code);
          if (!active || !signal.order_id || config.version !== signal.config_version && !signal.execution_guard) {
            await this.finish(tx, signal, 'needs_review', 'configuration_changed'); return;
          }
          const order = await tx.query('SELECT order_id FROM orders WHERE order_id=$1 AND delete_flag=false FOR UPDATE', [signal.order_id]);
          if (!order.rowCount) { await this.finish(tx,signal,'needs_review','order_unavailable'); return; }
          if (!signal.execution_guard) {
            const message = await tx.query<{ message_text: string }>('SELECT message_text FROM inbound_messages WHERE id=$1', [signal.message_id]);
            const rules = config.document.rules.filter(r => signal.rule_codes.includes(r.code) && r.enabled);
            for (const rule of rules) {
              const resolver = config.document.resolvers.find(r => r.code === rule.resolverCode);
              const ids = resolver ? await this.resolveReferences(tx, extractReferences(message.rows[0].message_text, resolver), resolver) : [];
              if (ids.length !== 1 || ids[0] !== String(signal.order_id)) { await this.finish(tx,signal,'needs_review','reference_changed'); return; }
            }
          }
          if (signal.execution_guard) {
            const state = await loadOrderAutomationState(tx, Number(signal.order_id));
            const rules = await listEnabledRulesForEvent(tx, 'message.signal_detected');
            if (signal.execution_guard !== digest([Number(signal.order_id), state, rules, config.version])) {
              await this.finish(tx, signal, 'needs_review', 'preview_changed'); return;
            }
          }
          await this.step(tx,id,'processing_started',null,{});
          await evaluateStatusAutomation(tx,this.event(signal,Number(signal.order_id)));
          const applied = await tx.query(`SELECT 1 FROM audit_log WHERE request_id=$1 AND event='status_automation.rule_applied' LIMIT 1`, [signal.processing_request_id]);
          await this.finish(tx,signal,applied.rowCount ? 'succeeded' : 'no_action',applied.rowCount ? null : 'no_applicable_action');
          await this.audit(tx,'message_signals.processed',id,null,signal.processing_request_id,{ orderId: signal.order_id, signalCode: signal.signal_code });
        });
      } catch {
        await this.db.transaction(async tx => {
          const result = await tx.query<{ state: string; attempt_count: number }>(`UPDATE inbound_signal_occurrences SET state=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'retry_wait' END,
          reason_code='processing_failed',next_attempt_at=now()+interval '1 minute',lock_token=NULL,locked_at=NULL,version=version+1,updated_at=now()
          WHERE id=$1 AND lock_token=$2 AND state='processing' RETURNING state,attempt_count`, [id,token]);
          if (result.rows[0]) await this.step(tx,id,result.rows[0].state,null,{ reason:'processing_failed',attemptCount:result.rows[0].attempt_count });
        });
      }
    }
  }
  private async finish(tx: TransactionClient, signal: Occurrence, state: string, reason: string | null) {
    await tx.query(`UPDATE inbound_signal_occurrences SET state=$2,reason_code=$3,version=version+1,updated_at=now(),
      finished_at=CASE WHEN $2 IN ('succeeded','no_action') THEN now() ELSE NULL END,lock_token=NULL,locked_at=NULL WHERE id=$1`,[signal.id,state,reason]);
    await this.step(tx,signal.id,state,null,{ reason });
  }
  async cleanup() {
    await this.db.query(`DELETE FROM inbound_messages WHERE id IN (SELECT id FROM inbound_messages WHERE expires_at<=now() ORDER BY expires_at LIMIT 500)`);
    await this.db.query(`DELETE FROM inbound_signal_commands WHERE created_at<now()-interval '90 days'`);
  }
  private async step(tx: TransactionClient,id: string,code: string,actor: string|null,details: object) {
    await tx.query('INSERT INTO inbound_signal_steps(signal_id,event_code,actor_user_id,details) VALUES($1,$2,$3,$4)',[id,code,actor,details]);
  }
  private async audit(tx: TransactionClient,event: string,id: string,actor: CurrentUser|null,requestId: string,metadata: Record<string,unknown>) {
    await auditService.record(tx,{ event,entityType:'inbound_signal',entityId:id,requestId,source:'message_processing',
      actorUserId:actor?.id ?? null,actorUsername:actor?.username ?? 'Обработка входящих сигналов',actorRole:actor?.role ?? null,
      relatedOrderId:metadata.orderId ? Number(metadata.orderId) : null,metadata });
  }
}
function configurationSchemaForTest() { return z.unknown(); }
