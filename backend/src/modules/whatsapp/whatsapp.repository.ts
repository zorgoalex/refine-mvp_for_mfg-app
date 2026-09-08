import { Inject, Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { auditService } from "../../common/audit/audit.service";
import { ApiError } from "../../common/errors/api-error";
import { DatabaseService } from "../../database/database.service";
import type { DatabaseClient } from "../../database/database.types";
import type { CurrentUser } from "../../permissions/current-user";
import type {
  RuleInput,
  RuleUpdate,
  TemplateInput,
  TemplateUpdate,
} from "./whatsapp.dto";
import type { InboundMessage } from "./whatsapp.types";

interface TemplateRow extends QueryResultRow {
  template_id: string;
  code: string;
  name: string;
  body: string;
  enabled: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface RuleRow extends QueryResultRow {
  rule_id: string;
  code: string;
  name: string;
  match_mode: "contains_any" | "exact_any";
  keywords: string[];
  template_id: string;
  template_name?: string;
  body?: string;
  template_version?: number;
  priority: number;
  enabled: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface JobRow extends QueryResultRow {
  delivery_job_id: string;
  state: string;
  destination: string | null;
  body: string | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  provider_message_id: string | null;
  lock_token: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class WhatsAppRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService
  ) {}

  async listTemplates() {
    const result = await this.database.query<TemplateRow>(
      "SELECT * FROM whatsapp_message_templates ORDER BY name,template_id"
    );
    return result.rows.map(mapTemplate);
  }

  async createTemplate(
    input: TemplateInput,
    actor: CurrentUser,
    requestId: string
  ) {
    return this.database.transaction(async (tx) => {
      const result = await tx.query<TemplateRow>(
        `INSERT INTO whatsapp_message_templates(code,name,body,enabled,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,
        [input.code, input.name, input.body, input.enabled, actor.id]
      );
      const row = requireRow(result.rows[0]);
      await auditService.record(
        tx,
        operatorAudit(
          "whatsapp.template.created",
          "whatsapp_template",
          row.template_id,
          actor,
          requestId,
          null,
          publicTemplate(row)
        )
      );
      return mapTemplate(row);
    });
  }

  async updateTemplate(
    id: number,
    input: TemplateUpdate,
    actor: CurrentUser,
    requestId: string
  ) {
    return this.database.transaction(async (tx) => {
      const before = requireRow(
        (
          await tx.query<TemplateRow>(
            "SELECT * FROM whatsapp_message_templates WHERE template_id=$1 FOR UPDATE",
            [id]
          )
        ).rows[0]
      );
      if (before.version !== input.version)
        throw new ApiError(
          409,
          "WHATSAPP_VERSION_CONFLICT",
          "Шаблон уже изменён"
        );
      const result = await tx.query<TemplateRow>(
        `UPDATE whatsapp_message_templates SET name=COALESCE($2,name),body=COALESCE($3,body),enabled=COALESCE($4,enabled),version=version+1,updated_by=$5,updated_at=now() WHERE template_id=$1 RETURNING *`,
        [
          id,
          input.name ?? null,
          input.body ?? null,
          input.enabled ?? null,
          actor.id,
        ]
      );
      const row = requireRow(result.rows[0]);
      await auditService.record(
        tx,
        operatorAudit(
          row.enabled
            ? "whatsapp.template.updated"
            : "whatsapp.template.disabled",
          "whatsapp_template",
          id,
          actor,
          requestId,
          publicTemplate(before),
          publicTemplate(row)
        )
      );
      return mapTemplate(row);
    });
  }

  async listRules() {
    const result = await this.database.query<RuleRow>(
      `SELECT r.*,t.name template_name FROM whatsapp_keyword_rules r JOIN whatsapp_message_templates t USING(template_id) ORDER BY r.priority,r.rule_id`
    );
    return result.rows.map(mapRule);
  }

  async createRule(input: RuleInput, actor: CurrentUser, requestId: string) {
    return this.database.transaction(async (tx) => {
      await ensureTemplate(tx, input.templateId);
      const result = await tx.query<RuleRow>(
        `INSERT INTO whatsapp_keyword_rules(code,name,match_mode,keywords,template_id,priority,enabled,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$8) RETURNING *`,
        [
          input.code,
          input.name,
          input.matchMode,
          JSON.stringify(input.keywords),
          input.templateId,
          input.priority,
          input.enabled,
          actor.id,
        ]
      );
      const row = requireRow(result.rows[0]);
      await auditService.record(
        tx,
        operatorAudit(
          "whatsapp.rule.created",
          "whatsapp_rule",
          row.rule_id,
          actor,
          requestId,
          null,
          publicRule(row)
        )
      );
      return mapRule(row);
    });
  }

  async updateRule(
    id: number,
    input: RuleUpdate,
    actor: CurrentUser,
    requestId: string
  ) {
    return this.database.transaction(async (tx) => {
      const before = requireRow(
        (
          await tx.query<RuleRow>(
            "SELECT * FROM whatsapp_keyword_rules WHERE rule_id=$1 FOR UPDATE",
            [id]
          )
        ).rows[0]
      );
      if (before.version !== input.version)
        throw new ApiError(
          409,
          "WHATSAPP_VERSION_CONFLICT",
          "Правило уже изменено"
        );
      if (input.templateId) await ensureTemplate(tx, input.templateId);
      const result = await tx.query<RuleRow>(
        `UPDATE whatsapp_keyword_rules SET name=COALESCE($2,name),match_mode=COALESCE($3,match_mode),keywords=COALESCE($4::jsonb,keywords),template_id=COALESCE($5,template_id),priority=COALESCE($6,priority),enabled=COALESCE($7,enabled),version=version+1,updated_by=$8,updated_at=now() WHERE rule_id=$1 RETURNING *`,
        [
          id,
          input.name ?? null,
          input.matchMode ?? null,
          input.keywords ? JSON.stringify(input.keywords) : null,
          input.templateId ?? null,
          input.priority ?? null,
          input.enabled ?? null,
          actor.id,
        ]
      );
      const row = requireRow(result.rows[0]);
      await auditService.record(
        tx,
        operatorAudit(
          row.enabled ? "whatsapp.rule.updated" : "whatsapp.rule.disabled",
          "whatsapp_rule",
          id,
          actor,
          requestId,
          publicRule(before),
          publicRule(row)
        )
      );
      return mapRule(row);
    });
  }

  async acceptInbound(message: InboundMessage) {
    return this.database.transaction(async (tx) => {
      const inserted = await tx.query<
        QueryResultRow & { webhook_event_id: string }
      >(
        `INSERT INTO whatsapp_webhook_events(external_event_id,session_name,chat_id,message_text,result_code) VALUES($1,$2,$3,$4,'unmatched') ON CONFLICT(external_event_id) DO NOTHING RETURNING webhook_event_id`,
        [
          message.externalEventId,
          message.sessionName,
          message.chatId,
          message.text,
        ]
      );
      const eventId = inserted.rows[0]?.webhook_event_id;
      if (!eventId) return { duplicate: true, result: "duplicate" as const };
      const rules = await tx.query<RuleRow>(
        `SELECT r.*,t.body,t.version template_version FROM whatsapp_keyword_rules r JOIN whatsapp_message_templates t USING(template_id) WHERE r.enabled AND t.enabled ORDER BY r.priority,r.rule_id`
      );
      const normalized = message.text.trim().toLocaleLowerCase("ru-RU");
      const matched = rules.rows.find((rule) =>
        rule.keywords.some((keyword) =>
          rule.match_mode === "exact_any"
            ? normalized === keyword
            : normalized.includes(keyword)
        )
      );
      if (!matched) {
        await auditService.record(
          tx,
          systemAudit(
            "whatsapp.webhook.received",
            "whatsapp_webhook",
            message.externalEventId,
            message.requestId,
            { result: "unmatched" }
          )
        );
        return { duplicate: false, result: "unmatched" as const };
      }
      await tx.query(
        `UPDATE whatsapp_webhook_events SET matched_rule_id=$2,result_code='queued' WHERE webhook_event_id=$1`,
        [eventId, matched.rule_id]
      );
      await tx.query(
        `INSERT INTO whatsapp_delivery_jobs(idempotency_key,destination,body,source_event_id,source_rule_id,source_template_id,source_template_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          `${message.externalEventId}:${matched.rule_id}:${matched.template_version}`,
          message.chatId,
          matched.body,
          eventId,
          matched.rule_id,
          matched.template_id,
          matched.template_version,
        ]
      );
      await auditService.record(
        tx,
        systemAudit(
          "whatsapp.webhook.received",
          "whatsapp_webhook",
          message.externalEventId,
          message.requestId,
          { result: "queued", ruleId: Number(matched.rule_id) }
        )
      );
      return { duplicate: false, result: "queued" as const };
    });
  }

  async listJobs(limit = 100) {
    const result = await this.database.query<JobRow>(
      `SELECT delivery_job_id,state,destination,body,attempt_count,error_code,error_message,provider_message_id,created_at,updated_at FROM whatsapp_delivery_jobs ORDER BY delivery_job_id DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapJob);
  }
  async retryJob(id: number, actor: CurrentUser, requestId: string) {
    return this.database.transaction(async (tx) => {
      const result = await tx.query<JobRow>(
        `UPDATE whatsapp_delivery_jobs SET state='pending',attempt_count=0,next_attempt_at=now(),error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=now() WHERE delivery_job_id=$1 AND state='failed' RETURNING *`,
        [id]
      );
      if (!result.rows[0])
        throw new ApiError(
          409,
          "WHATSAPP_RETRY_NOT_ALLOWED",
          "Повтор разрешён только для failed"
        );
      await auditService.record(
        tx,
        operatorAudit(
          "whatsapp.delivery.retry_requested",
          "whatsapp_delivery",
          id,
          actor,
          requestId,
          { state: "failed" },
          { state: "pending" }
        )
      );
      return mapJob(result.rows[0]);
    });
  }

  async claimJobs(
    workerId: string,
    batch: number,
    staleMs: number,
    maxAttempts: number
  ) {
    return this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE whatsapp_delivery_jobs SET state=CASE WHEN send_started_at IS NOT NULL THEN 'unknown' WHEN attempt_count >= $2 THEN 'failed' ELSE 'retry_wait' END,locked_by=NULL,locked_at=NULL,lock_token=NULL,error_code=CASE WHEN send_started_at IS NOT NULL THEN 'STALE_AFTER_DISPATCH' WHEN attempt_count >= $2 THEN 'MAX_ATTEMPTS' ELSE 'STALE_BEFORE_DISPATCH' END,next_attempt_at=CASE WHEN send_started_at IS NULL AND attempt_count < $2 THEN now()+(LEAST(300,power(2,attempt_count))::text||' seconds')::interval ELSE next_attempt_at END,updated_at=now(),finished_at=CASE WHEN send_started_at IS NOT NULL OR attempt_count >= $2 THEN now() ELSE NULL END WHERE state='processing' AND locked_at < now()-($1::int*interval '1 millisecond')`,
        [staleMs, maxAttempts]
      );
      const result = await tx.query<JobRow>(
        `WITH claimed AS (SELECT delivery_job_id FROM whatsapp_delivery_jobs WHERE state IN('pending','retry_wait') AND next_attempt_at<=now() AND attempt_count<$3 ORDER BY delivery_job_id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE whatsapp_delivery_jobs j SET state='processing',locked_by=$2,locked_at=now(),lock_token=gen_random_uuid(),attempt_count=attempt_count+1,send_started_at=NULL,updated_at=now() FROM claimed WHERE j.delivery_job_id=claimed.delivery_job_id RETURNING j.*`,
        [batch, workerId, maxAttempts]
      );
      return result.rows;
    });
  }
  async markSendStarted(id: number, token: string) {
    const result = await this.database.query<
      QueryResultRow & { delivery_job_id: string }
    >(
      `UPDATE whatsapp_delivery_jobs SET send_started_at=now(),updated_at=now() WHERE delivery_job_id=$1 AND lock_token=$2::uuid AND state='processing' RETURNING delivery_job_id`,
      [id, token]
    );
    return Boolean(result.rows[0]);
  }
  async finishJob(
    id: number,
    token: string,
    state: "sent" | "failed" | "unknown",
    providerMessageId?: string,
    errorCode?: string
  ) {
    await this.database.transaction(async (tx) => {
      const result = await tx.query<JobRow>(
        `UPDATE whatsapp_delivery_jobs SET state=$3,provider_message_id=$4,error_code=$5,locked_by=NULL,locked_at=NULL,lock_token=NULL,finished_at=now(),updated_at=now() WHERE delivery_job_id=$1 AND lock_token=$2::uuid AND state='processing' RETURNING *`,
        [id, token, state, providerMessageId ?? null, errorCode ?? null]
      );
      if (result.rows[0])
        await auditService.record(
          tx,
          systemAudit(
            `whatsapp.delivery.${state}`,
            "whatsapp_delivery",
            id,
            `whatsapp-delivery-${id}-${Date.now()}`,
            {
              attemptCount: result.rows[0].attempt_count,
              errorCode: errorCode ?? null,
            }
          )
        );
    });
  }
  async cleanupExpired() {
    const [events, jobs] = await Promise.all([
      this.database.query(
        `UPDATE whatsapp_webhook_events SET message_text=NULL,chat_id=NULL WHERE text_expires_at<now() AND(message_text IS NOT NULL OR chat_id IS NOT NULL)`
      ),
      this.database.query(
        `UPDATE whatsapp_delivery_jobs SET body=NULL,destination=NULL WHERE body_expires_at<now() AND state IN('sent','failed','unknown') AND(body IS NOT NULL OR destination IS NOT NULL)`
      ),
    ]);
    return { events: events.rowCount ?? 0, jobs: jobs.rowCount ?? 0 };
  }
  async diagnostics() {
    const [events, jobs] = await Promise.all([
      this.database.query<QueryResultRow & { received_at: Date }>(
        "SELECT received_at FROM whatsapp_webhook_events ORDER BY received_at DESC LIMIT 1"
      ),
      this.database.query<QueryResultRow & { state: string; count: string }>(
        "SELECT state,count(*)::text count FROM whatsapp_delivery_jobs GROUP BY state"
      ),
    ]);
    return {
      lastWebhookAt: events.rows[0]?.received_at?.toISOString() ?? null,
      queue: Object.fromEntries(
        jobs.rows.map((row) => [row.state, Number(row.count)])
      ),
    };
  }
  async listAudit() {
    const result = await this.database.query<
      QueryResultRow & {
        audit_id: string;
        event: string;
        entity_type: string;
        entity_id: string;
        username: string | null;
        request_id: string;
        source: string;
        created_at: Date;
      }
    >(
      `SELECT audit_id,event,entity_type,entity_id,username,request_id,source,created_at FROM audit_log WHERE entity_type LIKE 'whatsapp_%' ORDER BY created_at DESC LIMIT 100`
    );
    return result.rows.map((row) => ({
      auditId: row.audit_id,
      event: row.event,
      entityType: row.entity_type,
      entityId: row.entity_id,
      username: row.username,
      requestId: row.request_id,
      source: row.source,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

async function ensureTemplate(tx: DatabaseClient, id: number) {
  const result = await tx.query(
    "SELECT template_id FROM whatsapp_message_templates WHERE template_id=$1",
    [id]
  );
  if (!result.rows[0])
    throw new ApiError(422, "WHATSAPP_TEMPLATE_NOT_FOUND", "Шаблон не найден");
}
function requireRow<T>(row: T | undefined): T {
  if (!row)
    throw new ApiError(404, "WHATSAPP_NOT_FOUND", "Запись WhatsApp не найдена");
  return row;
}
function mapTemplate(row: TemplateRow) {
  return {
    id: Number(row.template_id),
    code: row.code,
    name: row.name,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function mapRule(row: RuleRow) {
  return {
    id: Number(row.rule_id),
    code: row.code,
    name: row.name,
    matchMode: row.match_mode,
    keywords: row.keywords,
    templateId: Number(row.template_id),
    templateName: row.template_name ?? null,
    priority: row.priority,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at?.toISOString?.() ?? null,
    updatedAt: row.updated_at?.toISOString?.() ?? null,
  };
}
function mapJob(row: JobRow) {
  return {
    id: Number(row.delivery_job_id),
    state: row.state,
    destination: row.destination,
    body: row.body,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function publicTemplate(row: TemplateRow) {
  return {
    code: row.code,
    name: row.name,
    enabled: row.enabled,
    version: row.version,
  };
}
function publicRule(row: RuleRow) {
  return {
    code: row.code,
    name: row.name,
    matchMode: row.match_mode,
    templateId: Number(row.template_id),
    priority: row.priority,
    enabled: row.enabled,
    version: row.version,
  };
}
function operatorAudit(
  event: string,
  entityType: string,
  entityId: string | number,
  actor: CurrentUser,
  requestId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
) {
  return {
    event,
    entityType,
    entityId,
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: actor.role,
    requestId,
    source: "erp_whatsapp_admin",
    before,
    after,
    diff: after,
    metadata: { correlationId: requestId },
  };
}
function systemAudit(
  event: string,
  entityType: string,
  entityId: string | number,
  requestId: string,
  metadata: Record<string, unknown>
) {
  return {
    event,
    entityType,
    entityId,
    actorUserId: null,
    actorUsername: null,
    actorRole: null,
    requestId,
    source: "waha_webhook",
    before: {},
    after: {},
    diff: {},
    metadata: { ...metadata, correlationId: requestId },
  };
}
