import { createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { auditService } from "../../common/audit/audit.service";
import { ApiError } from "../../common/errors/api-error";
import { DatabaseService } from "../../database/database.service";
import type { CurrentUser } from "../../permissions/current-user";
import type {
  RuleInput,
  RuleUpdate,
  TemplateInput,
  TemplateUpdate,
} from "./whatsapp.dto";
import { WahaClient } from "./waha.client";
import { WhatsAppRepository } from "./whatsapp.repository";
import { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";

@Injectable()
export class WhatsAppService {
  constructor(
    @Inject(WhatsAppRuntimeConfigService)
    private readonly runtime: WhatsAppRuntimeConfigService,
    @Inject(WhatsAppRepository) private readonly repository: WhatsAppRepository,
    @Inject(WahaClient) private readonly client: WahaClient,
    @Inject(DatabaseService) private readonly database: DatabaseService
  ) {}

  async status() {
    this.requireEnabled();
    const [
      health,
      version,
      server,
      session,
      me,
      capping,
      timelock,
      diagnostics,
    ] = await Promise.allSettled([
      this.client.health(),
      this.client.version(),
      this.client.serverStatus(),
      this.client.session(),
      this.client.me(),
      this.client.capping(),
      this.client.timelock(),
      this.repository.diagnostics(),
    ]);
    return {
      health: value(health),
      version: value(version),
      server: value(server),
      session: value(session),
      account: value(me),
      capping: value(capping),
      timelock: value(timelock),
      restrictions: restrictionDetails({
        capping: value(capping),
        timelock: value(timelock),
      }),
      diagnostics: value(diagnostics),
      degraded: [health, session].some((item) => item.status === "rejected"),
    };
  }
  qr() {
    this.requireEnabled();
    return this.client.qr();
  }
  listTemplates() {
    this.requireEnabled();
    return this.repository.listTemplates();
  }
  createTemplate(input: TemplateInput, actor: CurrentUser, requestId: string) {
    this.requireEnabled();
    return this.repository.createTemplate(input, actor, requestId);
  }
  updateTemplate(
    id: number,
    input: TemplateUpdate,
    actor: CurrentUser,
    requestId: string
  ) {
    this.requireEnabled();
    return this.repository.updateTemplate(id, input, actor, requestId);
  }
  listRules() {
    this.requireEnabled();
    return this.repository.listRules();
  }
  createRule(input: RuleInput, actor: CurrentUser, requestId: string) {
    this.requireEnabled();
    return this.repository.createRule(input, actor, requestId);
  }
  updateRule(
    id: number,
    input: RuleUpdate,
    actor: CurrentUser,
    requestId: string
  ) {
    this.requireEnabled();
    return this.repository.updateRule(id, input, actor, requestId);
  }
  listJobs() {
    this.requireEnabled();
    return this.repository.listJobs();
  }
  listAudit() {
    this.requireEnabled();
    return this.repository.listAudit();
  }
  retryJob(id: number, actor: CurrentUser, requestId: string) {
    this.requireEnabled();
    return this.repository.retryJob(id, actor, requestId);
  }
  cleanup() {
    this.requireEnabled();
    return this.repository.cleanupExpired();
  }

  async restart(
    actor: CurrentUser,
    requestId: string,
    restrictionConfirmed: boolean
  ) {
    this.requireEnabled();
    const status = await this.status();
    if (status.restrictions.length > 0 && !restrictionConfirmed)
      throw new ApiError(
        409,
        "WHATSAPP_RESTRICTION_CONFIRMATION_REQUIRED",
        "Перезапуск не снимет timelock или capping; подтвердите риск"
      );
    await auditService.record(
      this.database,
      operatorAudit(
        "whatsapp.session.restart_requested",
        this.runtime.getConfig().sessionName ?? "default",
        actor,
        requestId,
        { restrictionConfirmed }
      )
    );
    try {
      const result = await this.client.restart();
      await auditService.record(
        this.database,
        operatorAudit(
          "whatsapp.session.restart_completed",
          this.runtime.getConfig().sessionName ?? "default",
          actor,
          requestId,
          { restrictionConfirmed }
        )
      );
      return result;
    } catch (error) {
      await auditService.record(
        this.database,
        operatorAudit(
          "whatsapp.session.restart_failed",
          this.runtime.getConfig().sessionName ?? "default",
          actor,
          requestId,
          {
            errorCode:
              error instanceof ApiError ? error.code : "WAHA_UNAVAILABLE",
          }
        )
      );
      throw error;
    }
  }

  async webhook(
    rawBody: Buffer,
    signature: string | undefined,
    algorithm: string | undefined,
    timestamp: string | undefined,
    requestId: string
  ) {
    const config = this.runtime.getConfig();
    if (!config.enabled || !config.webhookSecret || !config.sessionName)
      throw new ApiError(
        503,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp integration is not configured"
      );
    try {
      verifyWebhook(
        rawBody,
        signature,
        algorithm,
        timestamp,
        config.webhookSecret
      );
    } catch (error) {
      await this.recordSystem(
        "whatsapp.webhook.rejected",
        "signature",
        requestId,
        { reason: error instanceof ApiError ? error.code : "INVALID" }
      );
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      await this.recordSystem("whatsapp.webhook.rejected", "json", requestId, {
        reason: "INVALID_JSON",
      });
      throw new ApiError(
        400,
        "WHATSAPP_WEBHOOK_INVALID_JSON",
        "Invalid webhook JSON"
      );
    }
    const parsed = parseInbound(body, config.sessionName, requestId);
    if (parsed.kind === "ignored") {
      await this.recordSystem(
        "whatsapp.webhook.received",
        privateIdentifier(config.webhookSecret, parsed.entityId),
        requestId,
        { result: "ignored", reason: parsed.reason }
      );
      return { accepted: true, result: "ignored" };
    }
    const safeMessage = {
      ...parsed.message,
      externalEventId: privateIdentifier(config.webhookSecret, parsed.message.externalEventId),
    };
    const result = await this.repository.acceptInbound(safeMessage);
    if (result.duplicate)
      await this.recordSystem(
        "whatsapp.webhook.duplicate",
        safeMessage.externalEventId,
        requestId,
        { result: "duplicate" }
      );
    return { accepted: true, result: result.result };
  }

  async processBatch() {
    const config = this.runtime.getConfig();
    this.requireEnabled();
    const jobs = await this.repository.claimJobs(
      config.relayWorkerId,
      config.relayBatchSize,
      config.relayStaleLockMs,
      config.relayMaxAttempts
    );
    let sent = 0,
      failed = 0,
      unknown = 0;
    for (const job of jobs) {
      const id = Number(job.delivery_job_id);
      const token = String(job.lock_token ?? "");
      if (!job.destination || !job.body || !token) {
        if (token)
          await this.repository.finishJob(
            id,
            token,
            "failed",
            undefined,
            "INVALID_JOB"
          );
        failed++;
        continue;
      }
      const owned = await this.repository.markSendStarted(id, token);
      if (!owned) continue;
      try {
        const result = await this.client.sendText(job.destination, job.body);
        await this.repository.finishJob(
          id,
          token,
          "sent",
          result.messageId && config.webhookSecret
            ? privateIdentifier(config.webhookSecret, result.messageId)
            : undefined
        );
        sent++;
      } catch (error) {
        await this.repository.finishJob(
          id,
          token,
          "unknown",
          undefined,
          error instanceof ApiError ? error.code : "WAHA_UNAVAILABLE"
        );
        unknown++;
      }
    }
    return { claimed: jobs.length, sent, failed, unknown };
  }

  private requireEnabled() {
    if (!this.runtime.getConfig().enabled)
      throw new ApiError(
        503,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp integration is disabled"
      );
  }
  private recordSystem(
    event: string,
    entityId: string,
    requestId: string,
    metadata: Record<string, unknown>
  ) {
    return auditService.record(this.database, {
      event,
      entityType: "whatsapp_webhook",
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
    });
  }
}

export function verifyWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  algorithm: string | undefined,
  timestamp: string | undefined,
  secret: string
) {
  if (algorithm?.toLowerCase() !== "sha512")
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_ALGORITHM_INVALID",
      "Invalid webhook algorithm"
    );
  if (!timestamp)
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_TIMESTAMP_INVALID",
      "Invalid webhook timestamp"
    );
  const numeric = Number(timestamp);
  const time = Number.isFinite(numeric)
    ? numeric > 1e12
      ? numeric
      : numeric * 1000
    : Date.parse(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000)
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_TIMESTAMP_INVALID",
      "Invalid webhook timestamp"
    );
  if (!signature || !/^[a-f0-9]{128}$/i.test(signature))
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_SIGNATURE_INVALID",
      "Invalid webhook signature"
    );
  const supplied = Buffer.from(signature, "hex");
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_SIGNATURE_INVALID",
      "Invalid webhook signature"
    );
}

export function parseInbound(
  value: unknown,
  sessionName: string,
  requestId: string
):
  | {
      kind: "message";
      message: {
        externalEventId: string;
        sessionName: string;
        chatId: string;
        text: string;
        requestId: string;
      };
    }
  | { kind: "ignored"; entityId: string; reason: string } {
  const root = record(value);
  if (!root)
    throw new ApiError(
      422,
      "WHATSAPP_WEBHOOK_INVALID",
      "Invalid webhook payload"
    );
  const session = typeof root.session === "string" ? root.session : "";
  if (session !== sessionName)
    throw new ApiError(
      401,
      "WHATSAPP_WEBHOOK_SESSION_INVALID",
      "Invalid webhook session"
    );
  if (root.event !== "message")
    return {
      kind: "ignored",
      entityId: String(root.event ?? "event"),
      reason: "event",
    };
  const payload = record(root.payload);
  if (!payload)
    throw new ApiError(
      422,
      "WHATSAPP_WEBHOOK_INVALID",
      "Invalid message payload"
    );
  const id = messageId(payload.id);
  if (!id || id.length > 255)
    throw new ApiError(422, "WHATSAPP_WEBHOOK_INVALID", "Invalid message id");
  if (payload.fromMe === true)
    return { kind: "ignored", entityId: id, reason: "from_me" };
  if (payload.source === "api")
    return { kind: "ignored", entityId: id, reason: "api_source" };
  const chatId = typeof payload.from === "string" ? payload.from : "";
  if (!/^[^@\s]{1,140}@c\.us$/.test(chatId))
    return { kind: "ignored", entityId: id, reason: "non_direct_chat" };
  const text = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!isPlainTextMessage(payload))
    return { kind: "ignored", entityId: id, reason: "non_text_message" };
  if (!text || [...text].length > 4096)
    return { kind: "ignored", entityId: id, reason: "invalid_text" };
  return {
    kind: "message",
    message: { externalEventId: id, sessionName, chatId, text, requestId },
  };
}

export function privateIdentifier(secret: string, value: string) {
  return `h1:${createHmac("sha256", secret).update(value).digest("hex")}`;
}

function isPlainTextMessage(payload: Record<string, unknown>): boolean {
  if (payload.hasMedia !== false || payload.media) return false;
  for (const marker of [
    "location",
    "latitude",
    "longitude",
    "vCards",
    "poll",
    "pollVotes",
    "reaction",
    "selectedOptions",
  ]) {
    if (payload[marker] !== undefined && payload[marker] !== null) return false;
  }
  const allowedTypes = new Set(["chat", "text", "conversation", "extendedTextMessage"]);
  if (typeof payload.type === "string" && !allowedTypes.has(payload.type)) return false;
  const raw = record(payload._data);
  if (typeof raw?.type === "string" && !allowedTypes.has(raw.type)) return false;
  return true;
}

export function restrictionDetails(status: {
  capping: unknown;
  timelock: unknown;
}) {
  const result: string[] = [];
  const capping = record(status.capping);
  const timelock = record(status.timelock);
  if (capping?.cappingStatus === "CAPPED") result.push("message_capping");
  if (timelock?.isActive === true) result.push("reachout_timelock");
  return result;
}
function value(result: PromiseSettledResult<unknown>) {
  return result.status === "fulfilled" ? result.value : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
function messageId(value: unknown) {
  if (typeof value === "string") return value;
  const item = record(value);
  return typeof item?._serialized === "string" ? item._serialized : "";
}
function operatorAudit(
  event: string,
  session: string,
  actor: CurrentUser,
  requestId: string,
  metadata: Record<string, unknown>
) {
  return {
    event,
    entityType: "whatsapp_session",
    entityId: session,
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: actor.role,
    requestId,
    source: "erp_whatsapp_admin",
    before: {},
    after: {},
    diff: {},
    metadata: { ...metadata, correlationId: requestId },
  };
}
