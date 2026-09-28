import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOnecCommandRepository, type CommandRow } from '../adapters/pg-onec-command-repository';
import { PgOnecEtlRepository } from '../adapters/pg-onec-etl-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { ETL_COMMAND_TYPES } from '../domain/onec-etl';
import {
  checkCommandPayload,
  commandKindOf,
  LEASE_SECONDS,
  leaseRequestSchema,
  OPERATOR_COMMAND_SCHEMAS,
  receivedRequestSchema,
  resultBodySchema,
} from '../domain/onec-commands';
import { buildOnecEvent } from '../domain/onec-events';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecAuditWriter, type OnecAgentContext, type OnecRequestContext } from './onec-audit';
import { OnecCommandWakeups } from './onec-command-wakeups';

/** Fallback poll while a long poll waits (a lost NOTIFY only delays delivery). */
const FALLBACK_POLL_MS = 5000;

/** Port for business modules (E4): enqueue inside the caller's transaction. */
export interface EnqueueCommand {
  agentId: string;
  commandType: string;
  payload: Record<string, unknown>;
  payloadVersion?: number;
  priority?: number;
  orderingKey?: string | null;
  correlationId?: string | null;
  notBeforeUtc?: string | null;
  expiresAtUtc?: string | null;
  requestedBy?: { userId?: string; displayName?: string } | null;
  sourceModule: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** Deduplicates repeated enqueues of the same intent (per source module). */
  idempotencyKey: string;
}

const operatorCommandSchema = z
  .object({
    commandType: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).default({}),
    priority: z.number().int().min(-1000).max(1000).default(0),
    orderingKey: z.string().min(1).max(200).nullable().optional(),
    notBeforeUtc: z.string().datetime({ offset: true }).nullable().optional(),
    expiresAtUtc: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** Stored key = `<userId>:<header>` for operators; the column allows 256. */
export const ONEC_IDEMPOTENCY_KEY_MAX = 256;
const OPERATOR_IDEMPOTENCY_HEADER_MAX = 200;

interface CommandIntent {
  agentId: string;
  commandType: string;
  payloadVersion: number;
  payloadHash: string;
  priority: number;
  orderingKey: string | null;
  notBeforeMs: number | null;
  expiresAtMs: number | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
}

function publishedCommandTypes(configurationCanonical: string): string[] {
  try {
    const parsed = JSON.parse(configurationCanonical) as { commandTypes?: unknown };
    return Array.isArray(parsed.commandTypes) ? parsed.commandTypes.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Mirrors markReceived: only queued/leased become received; terminal statuses stay. */
const receivedStatus = (status: string) => (status === 'queued' || status === 'leased' ? 'received' : status);

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export interface LeaseResponse {
  hasCommand: boolean;
  leaseId?: string;
  leaseExpiresAtUtc?: string;
  command?: unknown;
}

@Injectable()
export class OnecCommandsService {
  constructor(
    @Inject(PgOnecCommandRepository) private readonly commands: PgOnecCommandRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecCommandWakeups) private readonly wakeups: OnecCommandWakeups,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
  ) {}

  // ------------------------------------------------------------------ enqueue (port)

  /**
   * Validates, canonicalizes and stores a command in the caller's transaction;
   * the long poll is woken by NOTIFY after commit. Idempotent per
   * (sourceModule, idempotencyKey): the same intent returns the existing command,
   * a different payload/type/agent under the same key is a conflict.
   */
  async enqueue(tx: DatabaseClient, input: EnqueueCommand): Promise<{ command: CommandRow; created: boolean }> {
    const kind = commandKindOf(input.commandType);
    if (!kind) throw new ApiError(422, 'ONEC_COMMAND_TYPE_UNKNOWN', `Неизвестный тип команды ${input.commandType}`);
    const payloadVersion = input.payloadVersion ?? 1;
    if (payloadVersion !== 1) throw new ApiError(422, 'ONEC_COMMAND_PAYLOAD_VERSION', 'Поддерживается только payloadVersion=1');
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > ONEC_IDEMPOTENCY_KEY_MAX) {
      throw new ApiError(422, 'ONEC_COMMAND_IDEMPOTENCY_KEY', `Ключ идемпотентности: 8–${ONEC_IDEMPOTENCY_KEY_MAX} символов`);
    }
    const payload = checkCommandPayload(input.payload);
    if (!payload.ok) throw new ApiError(422, payload.code, payload.message);
    const intent: CommandIntent = {
      agentId: input.agentId,
      commandType: input.commandType,
      payloadVersion,
      payloadHash: payload.hash,
      priority: input.priority ?? 0,
      orderingKey: input.orderingKey ?? null,
      notBeforeMs: input.notBeforeUtc ? Date.parse(input.notBeforeUtc) : null,
      expiresAtMs: input.expiresAtUtc ? Date.parse(input.expiresAtUtc) : null,
      sourceEntityType: input.sourceEntityType ?? null,
      sourceEntityId: input.sourceEntityId ?? null,
    };
    // An identical repeat is answered before any time- or configuration-dependent check.
    const existing = await this.commands.findByIdempotencyKey(tx, input.sourceModule, input.idempotencyKey);
    if (existing) return { command: this.requireSameIntent(existing, intent), created: false };
    if (intent.expiresAtMs !== null && intent.expiresAtMs <= Date.now()) {
      throw new ApiError(422, 'ONEC_COMMAND_ALREADY_EXPIRED', 'Срок команды уже истёк');
    }
    const agent = await this.repository.getAgent(tx, input.agentId);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    if (kind === 'business') {
      // Business types only when enabled in the agent's published configuration (plan §6.2).
      const published = await this.repository.getPublishedConfig(tx, agent.agentId);
      const enabled = published ? publishedCommandTypes(published.configurationCanonical) : [];
      if (!enabled.includes(input.commandType)) {
        throw new ApiError(422, 'ONEC_COMMAND_TYPE_NOT_ENABLED', `Тип ${input.commandType} не включён в опубликованной конфигурации агента`);
      }
    }
    const result = await this.commands.insert(tx, {
      commandId: randomUUID(),
      agentId: agent.agentId,
      sourceId: agent.sourceId,
      commandType: input.commandType,
      commandKind: kind,
      payloadVersion,
      payloadCanonical: payload.canonical,
      payloadHash: payload.hash,
      payloadBytes: payload.bytes,
      priority: intent.priority,
      orderingKey: intent.orderingKey,
      correlationId: input.correlationId ?? null,
      notBeforeUtc: input.notBeforeUtc ?? null,
      expiresAtUtc: input.expiresAtUtc ?? null,
      requestedBy: input.requestedBy ?? null,
      sourceModule: input.sourceModule,
      sourceEntityType: intent.sourceEntityType,
      sourceEntityId: intent.sourceEntityId,
      idempotencyKey: input.idempotencyKey,
    });
    // Lost a concurrent insert race on the same key: same rules as the early lookup.
    if (!result.created) return { command: this.requireSameIntent(result.command, intent), created: false };
    await this.commands.notify(tx, agent.agentId);
    return result;
  }

  /** The whole immutable request must match; otherwise the key was reused for a different intent. */
  private requireSameIntent(stored: CommandRow, intent: CommandIntent): CommandRow {
    const time = (value: Date | null) => (value === null ? null : value.getTime());
    const same =
      stored.agentId === intent.agentId &&
      stored.commandType === intent.commandType &&
      stored.payloadVersion === intent.payloadVersion &&
      stored.payloadHash === intent.payloadHash &&
      stored.priority === intent.priority &&
      stored.orderingKey === intent.orderingKey &&
      time(stored.notBeforeUtc) === intent.notBeforeMs &&
      time(stored.expiresAtUtc) === intent.expiresAtMs &&
      stored.sourceEntityType === intent.sourceEntityType &&
      stored.sourceEntityId === intent.sourceEntityId;
    if (!same) {
      throw new ApiError(409, 'ONEC_COMMAND_IDEMPOTENCY_CONFLICT', 'Ключ идемпотентности уже использован для другой команды');
    }
    return stored;
  }

  /** Admin UI: admin commands and the integration probe only (business commands come from modules, E4). */
  async operatorEnqueue(agentId: string, body: unknown, idempotencyKey: string | undefined, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > OPERATOR_IDEMPOTENCY_HEADER_MAX) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', `Нужен заголовок Idempotency-Key (8–${OPERATOR_IDEMPOTENCY_HEADER_MAX} символов)`);
    }
    const parsed = operatorCommandSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Некорректные данные', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      });
    }
    const input = parsed.data;
    const schema = OPERATOR_COMMAND_SCHEMAS[input.commandType];
    if (!schema) throw new ApiError(422, 'ONEC_COMMAND_NOT_ALLOWED', 'Эту команду нельзя отправить вручную');
    const payload = schema.safeParse(input.payload);
    if (!payload.success) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Некорректные параметры команды', {
        issues: payload.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      });
    }
    const result = await this.commands.transaction(async (tx) => {
      const enqueued = await this.enqueue(tx, {
        agentId,
        commandType: input.commandType,
        payload: payload.data,
        priority: input.priority,
        orderingKey: input.orderingKey ?? null,
        correlationId: context.correlationId && z.string().uuid().safeParse(context.correlationId).success ? context.correlationId : null,
        notBeforeUtc: input.notBeforeUtc ?? null,
        expiresAtUtc: input.expiresAtUtc ?? null,
        requestedBy: { userId: actor.id, displayName: actor.username },
        sourceModule: 'onec_admin',
        idempotencyKey: `${actor.id}:${idempotencyKey}`,
      });
      if (enqueued.created) {
        await this.audit.byUser(
          tx,
          actor,
          context,
          {
            event: 'onec.command.enqueued',
            entityType: 'onec_agent_command',
            entityId: enqueued.command.commandId,
            after: {
              commandType: enqueued.command.commandType,
              payloadHash: enqueued.command.payloadHash,
              payloadBytes: enqueued.command.payloadBytes,
              priority: enqueued.command.priority,
            },
          },
          { agentId, sourceId: enqueued.command.sourceId, commandId: enqueued.command.commandId },
        );
      }
      return enqueued;
    });
    if (result.created) this.wakeups.wake(agentId);
    return { ...commandView(result.command, true), created: result.created };
  }

  // ------------------------------------------------------------------ agent: lease (long poll)

  async lease(agent: OnecAgentContext, body: unknown, signal: AbortSignal): Promise<LeaseResponse> {
    const parsed = leaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, 'INVALID_REQUEST', 'Invalid lease request', {
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      });
    }
    const input = parsed.data;
    const session = await this.commands.getSession(agent.agentId, input.sessionId);
    const ttl = this.runtime.get().sessionTtlMs;
    if (!session || !session.accepted || Date.now() - session.lastSeenAt.getTime() > ttl) {
      throw new ApiError(409, 'SESSION_EXPIRED', 'Session is unknown, not accepted or expired; start a new session');
    }
    // Claim before the first query: an older long poll of this agent ends even if this one leases at once.
    const token = this.wakeups.claim(agent.agentId);
    try {
      await this.commands.touchSession(input.sessionId);
      const deadline = Date.now() + input.maxWaitSeconds * 1000;
      const hasCapacity = !input.currentLoad || input.currentLoad.executing < input.currentLoad.capacity;
      for (;;) {
        if (signal.aborted || !this.wakeups.isCurrent(agent.agentId, token)) return { hasCommand: false };
        if (hasCapacity) {
          const command = await this.commands.leaseNext(agent.agentId, input.supportedCommandTypes, LEASE_SECONDS);
          if (command) {
            // Superseded or disconnected while the query ran: give the lease back instead of
            // answering a poll that is no longer the agent's current one.
            if (signal.aborted || !this.wakeups.isCurrent(agent.agentId, token)) {
              await this.commands.returnLease(command.commandId, command.leaseId!);
              return { hasCommand: false };
            }
            return this.leaseResponse(command);
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { hasCommand: false };
        const reason = await this.wakeups.wait(agent.agentId, token, Math.min(remaining, FALLBACK_POLL_MS), signal);
        if (reason === 'aborted' || reason === 'superseded') return { hasCommand: false };
      }
    } finally {
      this.wakeups.release(agent.agentId, token);
    }
  }

  private leaseResponse(command: CommandRow): LeaseResponse {
    // The canonical payload bytes are embedded verbatim (see controller); here as a parsed marker.
    return {
      hasCommand: true,
      leaseId: command.leaseId!,
      leaseExpiresAtUtc: command.leaseExpiresAt!.toISOString(),
      command,
    };
  }

  // ------------------------------------------------------------------ agent: received / result

  async received(agent: OnecAgentContext, commandId: string, body: unknown): Promise<void> {
    const parsed = receivedRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid received body');
    const verdict = await this.commands.transaction(async (tx): Promise<'ok' | 'hash_mismatch'> => {
      const command = await this.commands.getForUpdate(tx, agent.agentId, commandId);
      if (!command) throw new ApiError(404, 'COMMAND_NOT_FOUND', 'Command not found');
      if (parsed.data.payloadHash !== command.payloadHash) return 'hash_mismatch';
      if (command.receivedAt) return 'ok'; // idempotent repeat (also after a re-issue)
      await this.commands.markReceived(tx, commandId);
      if (command.status === 'expired_undelivered') await this.lateDelivery(tx, agent, command, 'received');
      await this.audit.byAgent(
        tx,
        agent,
        {
          event: 'onec.command.received',
          entityType: 'onec_agent_command',
          entityId: commandId,
          before: { status: command.status },
          after: { commandType: command.commandType, leaseCount: command.leaseCount, status: receivedStatus(command.status) },
          statusField: 'status',
          statusCode: receivedStatus(command.status),
        },
        { commandId, correlationId: command.correlationId },
      );
      return 'ok';
    });
    if (verdict === 'hash_mismatch') {
      // Recorded outside the (read-only) transaction so the refusal cannot roll it back.
      await this.incident(agent, 'command_hash_mismatch', `command_hash_mismatch:${commandId}`, { commandId, stage: 'received' });
      throw new ApiError(409, 'PAYLOAD_HASH_MISMATCH', 'payloadHash differs from the issued command');
    }
  }

  /**
   * The command was marked expired_undelivered (no receipt before expiresAt) but the
   * agent did get it: the receipt was lost. The terminal status stays (the queue
   * record is history), the fact is stored, an incident tells the operator, and the
   * "not delivered" alert is resolved because it is no longer true.
   */
  private async lateDelivery(tx: DatabaseClient, agent: OnecAgentContext, command: CommandRow, stage: 'received' | 'result', resultStatus?: string) {
    await this.repository.recordIncident(tx, {
      agentId: agent.agentId,
      kind: 'late_delivery_of_expired_command',
      dedupeKey: `late_delivery_of_expired_command:${command.commandId}`,
      details: { commandId: command.commandId, commandType: command.commandType, stage, resultStatus: resultStatus ?? null, requestId: agent.requestId },
    });
    await this.repository.resolveAlertByDedupeKey(tx, `command_expired_undelivered:${command.commandId}`);
  }

  /**
   * An accepted start_full_sync/reload_entity reports `{runId, mode}`: the run
   * learns its mode (plan §6.7 step 3). A run already completed as a scheduled
   * incremental run cannot be re-judged: incident, data unchanged.
   */
  private async linkEtlRun(tx: DatabaseClient, agent: OnecAgentContext, command: CommandRow, json: unknown): Promise<void> {
    if (!(ETL_COMMAND_TYPES as readonly string[]).includes(command.commandType)) return;
    const data = (json as { data?: { runId?: unknown; mode?: unknown } } | null)?.data;
    const runId = typeof data?.runId === 'string' && UUID_PATTERN.test(data.runId) ? data.runId.toLowerCase() : null;
    const mode = data?.mode === 'bootstrap_full' || data?.mode === 'entity_reload' || data?.mode === 'incremental' ? data.mode : null;
    if (!runId || !mode) return;
    const source = await this.repository.getSource(tx, command.sourceId);
    if (!source) return;
    const linked = await this.etl.recordCommandMode(tx, {
      runId,
      agentId: agent.agentId,
      sourceId: source.sourceId,
      generation: source.generation,
      generationRef: source.generationRef,
      mode,
      commandId: command.commandId,
    });
    if (linked.completed && linked.modeOrigin === 'no_pending_etl_command' && linked.mode !== mode) {
      await this.repository.recordIncident(tx, {
        agentId: agent.agentId,
        kind: 'late_mode_for_completed_run',
        dedupeKey: `late_mode_for_completed_run:${runId}`,
        details: { runId, commandId: command.commandId, mode, completedAs: linked.mode },
        runId,
      });
      // The mirror of this run was judged incremental; a full export is needed to trust it (plan §6.7 step 3).
      await this.repository.insertOutboxEvent(
        tx,
        buildOnecEvent({
          eventType: 'onec.etl.full_sync_required',
          severity: 'warning',
          actor: { kind: 'onec_agent', id: agent.agentId },
          agentId: agent.agentId,
          sourceId: command.sourceId,
          subject: { type: 'onec_etl_run', id: runId },
          requestId: agent.requestId,
          correlationId: command.correlationId ?? agent.correlationId,
          data: { runId, commandId: command.commandId, mode, completedAs: linked.mode },
          idempotencyKey: `onec.etl.full_sync_required:${runId}`,
        }),
      );
    }
  }

  private async incident(agent: OnecAgentContext, kind: string, dedupeKey: string, details: Record<string, unknown>): Promise<void> {
    await this.repository.recordIncident(this.repository.db, {
      agentId: agent.agentId,
      kind,
      dedupeKey,
      details: { ...details, requestId: agent.requestId },
    });
  }

  async result(agent: OnecAgentContext, commandId: string, rawBody: Buffer | undefined): Promise<void> {
    if (!rawBody || rawBody.length === 0) throw new ApiError(400, 'INVALID_REQUEST', 'Empty result body');
    const text = rawBody.toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'Result body is not JSON');
    }
    const parsed = resultBodySchema.safeParse(json);
    if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid result body');
    if (parsed.data.commandId.toLowerCase() !== commandId.toLowerCase()) {
      throw new ApiError(400, 'COMMAND_ID_MISMATCH', 'commandId in body differs from the path');
    }
    const sha = sha256Hex(text);
    const verdict = await this.commands.transaction(async (tx): Promise<'ok' | 'unknown' | { conflict: string }> => {
      const command = await this.commands.getForUpdate(tx, agent.agentId, commandId);
      if (!command) return 'unknown';
      if (command.resultSha256) {
        if (command.resultSha256 === sha) return 'ok'; // byte-identical repeat
        return { conflict: command.status };
      }
      const status = parsed.data.status;
      const errorCode = typeof parsed.data.error?.code === 'string' ? parsed.data.error.code : null;
      await this.commands.saveResult(tx, { commandId, status, body: text, sha256: sha, errorCode });
      if (command.status === 'expired_undelivered') await this.lateDelivery(tx, agent, command, 'result', status);
      if (status === 'succeeded') await this.linkEtlRun(tx, agent, command, json);
      if (command.status === 'cancelled') {
        // The fact outranks the intent: a cancelled command that was still executed.
        await this.repository.recordIncident(tx, {
          agentId: agent.agentId,
          kind: 'result_for_cancelled_command',
          dedupeKey: `result_for_cancelled_command:${commandId}`,
          details: { commandId, resultStatus: status },
        });
      }
      await this.audit.byAgent(
        tx,
        agent,
        {
          event: 'onec.command.completed',
          entityType: 'onec_agent_command',
          entityId: commandId,
          after: { commandType: command.commandType, status, errorCode, resultBytes: rawBody.length },
          statusField: 'status',
          statusCode: status,
        },
        { commandId, correlationId: command.correlationId },
      );
      await this.repository.insertOutboxEvent(
        tx,
        buildOnecEvent({
          eventType: 'onec.command.completed',
          severity: status === 'succeeded' ? 'info' : status === 'dead_letter' ? 'critical' : 'warning',
          actor: { kind: 'onec_agent', id: agent.agentId },
          agentId: agent.agentId,
          sourceId: agent.sourceId,
          subject: { type: 'onec_agent_command', id: commandId },
          requestId: agent.requestId,
          correlationId: command.correlationId ?? agent.correlationId,
          data: {
            commandId,
            commandType: command.commandType,
            status,
            errorCode,
            sourceModule: command.sourceModule,
            sourceEntityType: command.sourceEntityType,
            sourceEntityId: command.sourceEntityId,
          },
          idempotencyKey: `onec.command.completed:${commandId}`,
        }),
      );
      return 'ok';
    });
    // Incidents are written outside the refused transaction (a rollback would drop them).
    if (verdict === 'unknown') {
      await this.incident(agent, 'result_for_unknown_command', `result_for_unknown_command:${agent.agentId}:${commandId}`, { commandId });
      throw new ApiError(404, 'COMMAND_NOT_FOUND', 'Command not found');
    }
    if (typeof verdict === 'object') {
      await this.incident(agent, 'result_conflict', `result_conflict:${commandId}`, { commandId, storedStatus: verdict.conflict });
      throw new ApiError(409, 'RESULT_CONFLICT', 'A different result is already stored for this command');
    }
  }

  // ------------------------------------------------------------------ admin

  async cancel(commandId: string, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    return this.commands.transaction(async (tx) => {
      const cancelled = await this.commands.cancel(tx, commandId, Number(actor.id));
      if (!cancelled) {
        const current = await this.commands.getById(commandId, tx);
        if (!current) throw new ApiError(404, 'ONEC_COMMAND_NOT_FOUND', 'Команда не найдена');
        throw new ApiError(409, 'ONEC_COMMAND_NOT_CANCELLABLE', 'Команду уже получил агент или она завершена', { status: current.status });
      }
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.command.cancelled',
          entityType: 'onec_agent_command',
          entityId: commandId,
          after: { commandType: cancelled.commandType },
          statusField: 'status',
          statusCode: 'cancelled',
        },
        { agentId: cancelled.agentId, sourceId: cancelled.sourceId, commandId },
      );
      return commandView(cancelled, false);
    });
  }

  async list(query: { agentId?: string; status?: string; commandType?: string; limit?: string }) {
    this.runtime.requireEnabled();
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const rows = await this.commands.list({
      agentId: query.agentId || undefined,
      status: query.status || undefined,
      commandType: query.commandType || undefined,
      limit,
    });
    return rows.map((row) => commandView(row, false));
  }

  async get(commandId: string, includeBodies: boolean) {
    this.runtime.requireEnabled();
    const row = await this.commands.getById(commandId);
    if (!row) throw new ApiError(404, 'ONEC_COMMAND_NOT_FOUND', 'Команда не найдена');
    return commandView(row, includeBodies);
  }
}

/** Admin projection. Payload and result bodies only for roles that may send commands. */
export function commandView(row: CommandRow, includeBodies: boolean) {
  const parse = (text: string | null) => {
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
  return {
    commandId: row.commandId,
    agentId: row.agentId,
    commandType: row.commandType,
    commandKind: row.commandKind,
    status: row.status,
    priority: row.priority,
    orderingKey: row.orderingKey,
    payloadHash: row.payloadHash,
    payloadBytes: row.payloadBytes,
    notBeforeUtc: row.notBeforeUtc,
    expiresAtUtc: row.expiresAtUtc,
    requestedBy: row.requestedBy,
    sourceModule: row.sourceModule,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    leaseCount: row.leaseCount,
    leasedAt: row.leasedAt,
    receivedAt: row.receivedAt,
    resultReceivedAt: row.resultReceivedAt,
    resultErrorCode: row.resultErrorCode,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    ...(includeBodies ? { payload: parse(row.payloadCanonical), result: parse(row.resultBody) } : {}),
  };
}
