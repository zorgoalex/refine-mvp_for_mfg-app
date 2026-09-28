import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { parseStrictJson, toPlainValue } from '../canonical-json/canonical-json';
import { formatFingerprint, OnecCertificateError, parseCertificateInput } from '../domain/onec-certificates';
import {
  DEFAULT_ONEC_AGENT_CONFIGURATION,
  validateOnecConfiguration,
  type OnecAgentConfiguration,
} from '../domain/onec-config';
import { AGENT_VERSION_PATTERN } from '../domain/onec-protocol';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecAuditWriter, type OnecRequestContext } from './onec-audit';

const sourceCreateSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'латиница в нижнем регистре, цифры, _ и -'),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();
const sourceUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(200) }).strict();
const agentCreateSchema = z
  .object({
    agentId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'латиница, цифры, точка, _ и -'),
    sourceId: z.number().int().positive(),
    siteId: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(200),
    minimumAgentVersion: z.string().regex(AGENT_VERSION_PATTERN).default('1.0'),
  })
  .strict();
const agentUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    siteId: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    minimumAgentVersion: z.string().regex(AGENT_VERSION_PATTERN).optional(),
  })
  .strict();
const agentStatusSchema = z.object({ version: z.number().int().positive() }).strict();
const certificateSchema = z
  .object({ pem: z.string().max(64 * 1024).optional(), sha256Fingerprint: z.string().max(200).optional() })
  .strict();
const draftSchema = z.object({ configuration: z.unknown() }).strict();
const publishSchema = z.object({ revision: z.number().int().positive(), configHash: z.string().min(1).max(100) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Некорректные данные', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

const actorId = (actor: CurrentUser): number => Number(actor.id);

/** Alerts about a single past fact; nothing re-derives them, so an operator closes them. */
export const ONEC_OPERATOR_RESOLVABLE_ALERT_KINDS = ['command_dead_letter', 'command_expired_undelivered'] as const;

@Injectable()
export class OnecAdminService {
  constructor(
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  // ------------------------------------------------------------ overview

  async overview() {
    this.runtime.requireEnabled();
    const config = this.runtime.get();
    const [agents, openAlerts] = await Promise.all([this.repository.listAgents(), this.repository.countOpenAlerts()]);
    return {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      silentAfterMs: config.heartbeatIntervalMs * 3,
      monitorOwner: config.monitorOwner,
      openAlerts,
      agents: agents.map((row) => this.agentView(row, config.heartbeatIntervalMs)),
    };
  }

  // ------------------------------------------------------------ sources

  async listSources() {
    this.runtime.requireEnabled();
    const rows = await this.repository.listSources();
    return rows.map((row) => ({
      sourceId: Number(row.source_id),
      code: row.code,
      displayName: row.display_name,
      identity: row.identity ?? null,
      identityStatus: row.identity_status,
      generation: Number(row.generation),
      agentId: row.agent_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createSource(body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(sourceCreateSchema, body);
    return this.repository.transaction(async (tx) => {
      const source = await this.repository.insertSource(tx, { ...input, actorId: actorId(actor) }).catch((error: unknown) => {
        throw uniqueViolation(error, 'ONEC_SOURCE_CODE_TAKEN', 'Источник с таким кодом уже есть');
      });
      await this.audit.byUser(
        tx,
        actor,
        context,
        { event: 'onec.source.created', entityType: 'onec_source', entityId: source.sourceId, after: { code: source.code, displayName: source.displayName } },
        { sourceId: source.sourceId, sourceGeneration: source.generation },
      );
      return source;
    });
  }

  async updateSource(sourceId: number, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(sourceUpdateSchema, body);
    return this.repository.transaction(async (tx) => {
      const before = await this.repository.getSource(tx, sourceId, true);
      if (!before) throw new ApiError(404, 'ONEC_SOURCE_NOT_FOUND', 'Источник не найден');
      const after = await this.repository.updateSourceName(tx, sourceId, input.displayName, actorId(actor));
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.source.updated',
          entityType: 'onec_source',
          entityId: sourceId,
          before: { displayName: before.displayName },
          after: { displayName: input.displayName },
        },
        { sourceId },
      );
      return after;
    });
  }

  // ------------------------------------------------------------ agents

  async getAgent(agentId: string) {
    this.runtime.requireEnabled();
    const config = this.runtime.get();
    const row = (await this.repository.listAgents()).find((item) => item.agent_id === agentId);
    if (!row) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    const [certificates, history] = await Promise.all([
      this.repository.listCertificates(agentId),
      this.repository.listStatusHistory(agentId, 100),
    ]);
    return {
      ...this.agentView(row, config.heartbeatIntervalMs),
      heartbeat: row.heartbeat ?? null,
      certificates: certificates.map(certificateView),
      history: history.map((item) => ({ at: item.at, state: item.state, stateReason: item.state_reason, summary: item.summary })),
    };
  }

  async createAgent(body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(agentCreateSchema, body);
    return this.repository.transaction(async (tx) => {
      const source = await this.repository.getSource(tx, input.sourceId, true);
      if (!source) throw new ApiError(404, 'ONEC_SOURCE_NOT_FOUND', 'Источник не найден');
      const agent = await this.repository
        .insertAgent(tx, { ...input, actorId: actorId(actor) })
        .catch((error: unknown) => {
          throw uniqueViolation(error, 'ONEC_AGENT_CONFLICT', 'Агент с таким ID уже есть или у источника уже есть агент');
        });
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.agent.created',
          entityType: 'onec_agent',
          entityId: agent.agentId,
          after: { agentId: agent.agentId, sourceId: agent.sourceId, siteId: agent.siteId, displayName: agent.displayName, minimumAgentVersion: agent.minimumAgentVersion },
        },
        { agentId: agent.agentId, sourceId: agent.sourceId },
      );
      return agent;
    });
  }

  async updateAgent(agentId: string, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(agentUpdateSchema, body);
    return this.repository.transaction(async (tx) => {
      const before = await this.requireAgentVersion(tx, agentId, input.version);
      const after = await this.repository.updateAgent(tx, agentId, input, actorId(actor));
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.agent.updated',
          entityType: 'onec_agent',
          entityId: agentId,
          before: { siteId: before.siteId, displayName: before.displayName, minimumAgentVersion: before.minimumAgentVersion },
          after: { siteId: after.siteId, displayName: after.displayName, minimumAgentVersion: after.minimumAgentVersion },
        },
        { agentId, sourceId: after.sourceId },
      );
      return after;
    });
  }

  async setAgentStatus(agentId: string, status: 'active' | 'blocked', body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(agentStatusSchema, body);
    const result = await this.repository.transaction(async (tx) => {
      const before = await this.requireAgentVersion(tx, agentId, input.version);
      if (before.status === status) return before;
      const after = await this.repository.updateAgent(tx, agentId, { status }, actorId(actor));
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: status === 'blocked' ? 'onec.agent.blocked' : 'onec.agent.unblocked',
          entityType: 'onec_agent',
          entityId: agentId,
          before: { status: before.status },
          after: { status },
          statusField: 'status',
          statusCode: status,
        },
        { agentId, sourceId: after.sourceId },
      );
      return after;
    });
    return result;
  }

  private async requireAgentVersion(tx: Parameters<PgOnecRepository['getAgent']>[0], agentId: string, version: number) {
    const agent = await this.repository.getAgent(tx, agentId, true);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    if (agent.version !== version) {
      throw new ApiError(409, 'ONEC_AGENT_STALE', 'Агент изменён другим пользователем; обновите данные', { currentVersion: agent.version });
    }
    return agent;
  }

  // ------------------------------------------------------------ certificates

  async addCertificate(agentId: string, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(certificateSchema, body);
    let parsed;
    try {
      parsed = parseCertificateInput(input);
    } catch (error) {
      if (error instanceof OnecCertificateError) throw new ApiError(422, 'ONEC_CERTIFICATE_INVALID', error.message);
      throw error;
    }
    if (parsed.notAfter && parsed.notAfter.getTime() <= Date.now()) {
      throw new ApiError(422, 'ONEC_CERTIFICATE_EXPIRED', 'Срок действия сертификата истёк');
    }
    const row = await this.repository.transaction(async (tx) => {
      const agent = await this.repository.getAgent(tx, agentId, true);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
      const inserted = await this.repository.insertCertificate(tx, { agentId, ...parsed, actorId: actorId(actor) });
      if (!inserted) throw new ApiError(409, 'ONEC_CERTIFICATE_TAKEN', 'Этот сертификат уже зарегистрирован');
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.certificate.added',
          entityType: 'onec_agent_certificate',
          entityId: Number(inserted.cert_id),
          after: {
            agentId,
            sha256Fingerprint: formatFingerprint(parsed.fingerprint),
            subject: parsed.subject,
            notBefore: parsed.notBefore?.toISOString() ?? null,
            notAfter: parsed.notAfter?.toISOString() ?? null,
          },
        },
        { agentId, sourceId: agent.sourceId, certId: Number(inserted.cert_id) },
      );
      return inserted;
    });
    return certificateView(row);
  }

  async revokeCertificate(agentId: string, certId: number, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const row = await this.repository.transaction(async (tx) => {
      const agent = await this.repository.getAgent(tx, agentId, true);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
      const revoked = await this.repository.revokeCertificate(tx, agentId, certId, actorId(actor));
      if (!revoked) throw new ApiError(404, 'ONEC_CERTIFICATE_NOT_FOUND', 'Активный сертификат не найден');
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.certificate.revoked',
          entityType: 'onec_agent_certificate',
          entityId: certId,
          before: { status: 'active' },
          after: { status: 'revoked', sha256Fingerprint: formatFingerprint(revoked.sha256_fingerprint) },
          statusField: 'status',
          statusCode: 'revoked',
        },
        { agentId, sourceId: agent.sourceId, certId },
      );
      await tx.query(
        `UPDATE onec_alerts SET state = 'resolved', resolved_at = now() WHERE cert_id = $1 AND state <> 'resolved'`,
        [certId],
      );
      return revoked;
    });
    return certificateView(row);
  }

  // ------------------------------------------------------------ configuration

  async getConfiguration(agentId: string) {
    this.runtime.requireEnabled();
    const db = this.repository.db;
    const agent = await this.repository.getAgent(db, agentId);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    const [draft, published, status] = await Promise.all([
      this.repository.getDraft(db, agentId),
      this.repository.getPublishedConfig(db, agentId),
      db.query(`SELECT active_config_version, rejected_config_version, rejected_reason FROM onec_agent_status WHERE agent_id = $1`, [agentId]),
    ]);
    const statusRow = status.rows[0];
    return {
      agentId,
      publishBlocked: agent.configPublishBlocked,
      draft: draft
        ? {
            revision: Number(draft.revision),
            configHash: draft.config_hash,
            configuration: toPlainValue(parseStrictJson(draft.configuration_canonical)),
            updatedAt: draft.updated_at,
          }
        : null,
      published: published
        ? {
            configVersion: published.configVersion,
            configHash: published.configHash,
            configuration: toPlainValue(parseStrictJson(published.configurationCanonical)),
          }
        : null,
      agentReported: {
        activeConfigVersion: statusRow?.active_config_version === null || statusRow?.active_config_version === undefined ? null : Number(statusRow.active_config_version),
        rejectedConfigVersion: statusRow?.rejected_config_version === null || statusRow?.rejected_config_version === undefined ? null : Number(statusRow.rejected_config_version),
        rejectedReason: statusRow?.rejected_reason ?? null,
      },
      defaults: DEFAULT_ONEC_AGENT_CONFIGURATION,
    };
  }

  /** Validates without saving (live feedback in the editor). */
  validateConfiguration(body: unknown) {
    this.runtime.requireEnabled();
    const input = parse(draftSchema, body);
    const result = validateOnecConfiguration(input.configuration);
    return result.ok
      ? { ok: true as const, configHash: result.canonical.hash, bytes: result.canonical.bytes, issues: [] }
      : { ok: false as const, issues: result.issues };
  }

  async saveDraft(agentId: string, ifMatch: string | undefined, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(draftSchema, body);
    const expectedRevision = parseIfMatch(ifMatch);
    const validation = validateOnecConfiguration(input.configuration);
    if (!validation.ok) {
      throw new ApiError(422, 'ONEC_CONFIG_INVALID', 'Конфигурация не прошла проверку', { issues: validation.issues });
    }
    return this.repository.transaction(async (tx) => {
      const agent = await this.repository.getAgent(tx, agentId, true);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
      const saved = await this.repository.upsertDraft(tx, {
        agentId,
        expectedRevision,
        canonical: validation.canonical.canonical,
        hash: validation.canonical.hash,
        actorId: actorId(actor),
      });
      if (!saved) {
        const current = await this.repository.getDraft(tx, agentId);
        throw new ApiError(409, 'STALE_DRAFT', 'Черновик изменён другим пользователем; обновите страницу', {
          currentRevision: current ? Number(current.revision) : null,
        });
      }
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.config.draft_saved',
          entityType: 'onec_agent_config_draft',
          entityId: agentId,
          after: { revision: Number(saved.revision), configHash: validation.canonical.hash, bytes: validation.canonical.bytes },
        },
        { agentId, sourceId: agent.sourceId },
      );
      return { revision: Number(saved.revision), configHash: validation.canonical.hash, configuration: validation.configuration };
    });
  }

  async publish(agentId: string, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    const input = parse(publishSchema, body);
    return this.repository.transaction(async (tx) => {
      const agent = await this.repository.getAgent(tx, agentId, true);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
      if (agent.configPublishBlocked) {
        throw new ApiError(409, 'ONEC_CONFIG_PUBLISH_BLOCKED', 'Публикация заблокирована до первого heartbeat агента после восстановления');
      }
      const draft = await this.repository.getDraft(tx, agentId, true);
      if (!draft || Number(draft.revision) !== input.revision || draft.config_hash !== input.configHash) {
        throw new ApiError(409, 'STALE_DRAFT', 'Черновик изменился после подтверждения; проверьте его ещё раз');
      }
      const published = await this.repository.getPublishedConfig(tx, agentId);
      if (published && published.configHash === draft.config_hash) {
        throw new ApiError(409, 'ONEC_CONFIG_UNCHANGED', 'Черновик совпадает с опубликованной конфигурацией');
      }
      // Never reuse a version the agent may have seen (plan §5.1): above the
      // table and agent-reported maximum, and not below publication time in ms.
      const floor = await this.repository.configVersionFloor(tx, agentId);
      const configVersion = Math.max(floor + 1, Date.now());
      await this.repository.publishConfigVersion(tx, {
        agentId,
        configVersion,
        canonical: draft.configuration_canonical,
        hash: draft.config_hash,
        revision: Number(draft.revision),
        actorId: actorId(actor),
      });
      const configuration = toPlainValue(parseStrictJson(draft.configuration_canonical)) as OnecAgentConfiguration;
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.config.published',
          entityType: 'onec_agent_config_version',
          entityId: `${agentId}:${configVersion}`,
          before: published ? { configVersion: published.configVersion, configHash: published.configHash } : {},
          after: { configVersion, configHash: draft.config_hash, revision: Number(draft.revision), mode: configuration.mode },
        },
        { agentId, sourceId: agent.sourceId, configVersion },
      );
      return { configVersion, configHash: draft.config_hash };
    });
  }

  async listConfigVersions(agentId: string) {
    this.runtime.requireEnabled();
    const rows = await this.repository.listConfigVersions(agentId);
    return rows.map((row) => ({
      configVersion: Number(row.config_version),
      status: row.status,
      configHash: row.config_hash,
      publishedFromRevision: Number(row.published_from_revision),
      publishedAt: row.published_at,
      publishedBy: row.published_by_name ?? null,
      configuration: toPlainValue(parseStrictJson(row.configuration_canonical)),
    }));
  }

  // ------------------------------------------------------------ incidents & alerts

  async listIncidents(query: { agentId?: string; open?: string; limit?: string }) {
    this.runtime.requireEnabled();
    const rows = await this.repository.listIncidents({
      agentId: query.agentId || undefined,
      open: query.open === undefined ? undefined : query.open === 'true',
      limit: clampLimit(query.limit),
    });
    return rows.map((row) => ({
      incidentId: Number(row.incident_id),
      agentId: row.agent_id,
      kind: row.kind,
      details: row.details,
      occurrences: Number(row.occurrences),
      firstAt: row.first_at,
      lastAt: row.last_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async resolveIncident(incidentId: number, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    return this.repository.transaction(async (tx) => {
      const row = await this.repository.resolveIncident(tx, incidentId, actorId(actor));
      if (!row) throw new ApiError(404, 'ONEC_INCIDENT_NOT_FOUND', 'Открытый инцидент не найден');
      await this.audit.byUser(
        tx,
        actor,
        context,
        { event: 'onec.incident.resolved', entityType: 'onec_agent_incident', entityId: incidentId, after: { kind: row.kind }, statusCode: 'resolved' },
        { agentId: row.agent_id ?? null },
      );
      return { incidentId, resolvedAt: row.resolved_at };
    });
  }

  async listAlerts(query: { agentId?: string; state?: string; limit?: string }) {
    this.runtime.requireEnabled();
    const state = query.state && ['open', 'acknowledged', 'resolved'].includes(query.state) ? query.state : undefined;
    const rows = await this.repository.listAlerts({ agentId: query.agentId || undefined, state, limit: clampLimit(query.limit) });
    return rows.map((row) => ({
      alertId: Number(row.alert_id),
      kind: row.kind,
      agentId: row.agent_id,
      agentName: row.agent_name ?? null,
      certId: row.cert_id === null ? null : Number(row.cert_id),
      severity: row.severity,
      state: row.state,
      details: row.details,
      openedAt: row.opened_at,
      lastSeenAt: row.last_seen_at,
      acknowledgedAt: row.acknowledged_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async acknowledgeAlert(alertId: number, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    return this.repository.transaction(async (tx) => {
      const row = await this.repository.acknowledgeAlert(tx, alertId, actorId(actor));
      if (!row) throw new ApiError(404, 'ONEC_ALERT_NOT_FOUND', 'Открытый алерт не найден');
      await this.audit.byUser(
        tx,
        actor,
        context,
        { event: 'onec.alert.acknowledged', entityType: 'onec_alert', entityId: alertId, after: { kind: row.kind }, statusCode: 'acknowledged' },
        { agentId: row.agent_id ?? null, sourceId: row.source_id === null ? null : Number(row.source_id), certId: row.cert_id === null ? null : Number(row.cert_id) },
      );
      return { alertId, state: 'acknowledged' };
    });
  }

  /** One-shot command alerts are closed by the operator once handled; state alerts resolve themselves. */
  async resolveAlert(alertId: number, actor: CurrentUser, context: OnecRequestContext) {
    this.runtime.requireEnabled();
    return this.repository.transaction(async (tx) => {
      const row = await this.repository.resolveAlert(tx, alertId, ONEC_OPERATOR_RESOLVABLE_ALERT_KINDS);
      if (!row) throw new ApiError(404, 'ONEC_ALERT_NOT_FOUND', 'Незакрытый алерт команды не найден');
      await this.audit.byUser(
        tx,
        actor,
        context,
        { event: 'onec.alert.resolved', entityType: 'onec_alert', entityId: alertId, after: { kind: row.kind }, statusCode: 'resolved' },
        {
          agentId: row.agent_id ?? null,
          sourceId: row.source_id === null ? null : Number(row.source_id),
          commandId: typeof row.details?.commandId === 'string' ? row.details.commandId : null,
        },
      );
      return { alertId, state: 'resolved' };
    });
  }

  // ------------------------------------------------------------ views

  private agentView(row: QueryResultRow, heartbeatIntervalMs: number) {
    const receivedAt: Date | null = row.received_at ?? null;
    const silent = !receivedAt || Date.now() - receivedAt.getTime() > heartbeatIntervalMs * 3;
    return {
      agentId: row.agent_id,
      displayName: row.display_name,
      siteId: row.site_id,
      status: row.status,
      version: Number(row.version),
      minimumAgentVersion: row.minimum_agent_version,
      source: {
        sourceId: Number(row.source_id),
        code: row.source_code,
        displayName: row.source_name,
        identityStatus: row.identity_status,
        identity: row.identity ?? null,
      },
      connection: silent ? (receivedAt ? 'silent' : 'never_seen') : 'online',
      lastHeartbeatAt: receivedAt,
      agentVersion: row.agent_version ?? null,
      state: row.state ?? null,
      stateReason: row.state_reason ?? null,
      queues: row.heartbeat?.queues ?? null,
      oneC: row.heartbeat?.oneC ?? null,
      certificate: {
        reportedExpiresAt: row.cert_expires_at ?? null,
        nearestRegisteredNotAfter: row.nearest_cert_not_after ?? null,
        activeCount: Number(row.active_cert_count ?? 0),
      },
      config: {
        publishedVersion: row.published_config_version === null ? null : Number(row.published_config_version),
        activeVersion: row.active_config_version === null ? null : Number(row.active_config_version),
        rejectedVersion: row.rejected_config_version === null ? null : Number(row.rejected_config_version),
        rejectedReason: row.rejected_reason ?? null,
        publishBlocked: row.config_publish_blocked,
      },
      openAlerts: Number(row.open_alert_count ?? 0),
    };
  }
}

function certificateView(row: QueryResultRow) {
  return {
    certId: Number(row.cert_id),
    agentId: row.agent_id,
    sha256Fingerprint: formatFingerprint(row.sha256_fingerprint),
    subject: row.subject ?? null,
    notBefore: row.not_before ?? null,
    notAfter: row.not_after ?? null,
    status: row.status,
    addedAt: row.added_at,
    revokedAt: row.revoked_at ?? null,
  };
}

function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined || value === '' || value === '*') return null;
  const text = value.replace(/^W\//, '').replace(/"/g, '').trim();
  if (!/^[0-9]{1,15}$/.test(text)) throw new ApiError(400, 'INVALID_IF_MATCH', 'If-Match must be the draft revision');
  return Number(text);
}

function clampLimit(value: string | undefined): number {
  const n = Number(value ?? 100);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 100;
}

function uniqueViolation(error: unknown, code: string, message: string): unknown {
  if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') return new ApiError(409, code, message);
  return error;
}
