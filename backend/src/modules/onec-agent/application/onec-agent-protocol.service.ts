import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecRepository, type SourceRecord } from '../adapters/pg-onec-repository';
import { parseStrictJson, toPlainValue } from '../canonical-json/canonical-json';
import { isMaintenanceMode, type OnecAgentMode } from '../domain/onec-config';
import {
  heartbeatSchema,
  isVersionAtLeast,
  sameSourceIdentity,
  sessionStartSchema,
  type HeartbeatRequest,
} from '../domain/onec-protocol';
import { buildOnecEvent } from '../domain/onec-events';
import { OnecAuditWriter, type OnecAgentContext } from './onec-audit';

function agentEventBase(agent: OnecAgentContext) {
  return {
    actor: { kind: 'onec_agent' as const, id: agent.agentId },
    agentId: agent.agentId,
    sourceId: agent.sourceId,
    requestId: agent.requestId,
    correlationId: agent.correlationId,
  };
}

/** Status history is written on every state change and at most every 10 minutes otherwise. */
const HISTORY_SAMPLE_MS = 10 * 60 * 1000;

export interface SessionStartResponse {
  sessionId: string;
  serverTimeUtc: string;
  accepted: boolean;
  minimumAgentVersion: string;
  configVersion: number;
  maintenanceMode: boolean;
}

export type ConfigurationResponse = { notModified: true } | { notModified: false; body: string };

type Identity = NonNullable<SourceRecord['identity']>;

@Injectable()
export class OnecAgentProtocolService {
  constructor(
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
  ) {}

  async startSession(agent: OnecAgentContext, body: unknown): Promise<SessionStartResponse> {
    const input = parseBody(sessionStartSchema, body);
    if (input.agentId !== agent.agentId) {
      throw new ApiError(400, 'AGENT_ID_MISMATCH', 'agentId in body does not match the authenticated agent');
    }
    return this.repository.transaction(async (tx) => {
      const record = await this.repository.getAgent(tx, agent.agentId, true);
      if (!record) throw new ApiError(403, 'AGENT_UNKNOWN', 'Agent is not registered');
      const identityStatus = await this.checkIdentity(tx, agent, input.sourceIdentity ?? null);
      const published = await this.repository.getPublishedConfig(tx, agent.agentId);
      const mode = published ? modeOf(published.configurationCanonical) : 'Normal';
      const accepted =
        record.status === 'active' &&
        identityStatus !== 'identity_changed' &&
        isVersionAtLeast(input.agentVersion, record.minimumAgentVersion);
      const session = await this.repository.createSession(tx, {
        agentId: agent.agentId,
        agentVersion: input.agentVersion,
        localSchemaVersion: input.localSchemaVersion ?? null,
        capabilities: input.capabilities,
        accepted,
        sourceIdentity: input.sourceIdentity ?? null,
      });
      return {
        sessionId: session.sessionId,
        serverTimeUtc: new Date().toISOString(),
        accepted,
        minimumAgentVersion: record.minimumAgentVersion,
        configVersion: published?.configVersion ?? 0,
        maintenanceMode: isMaintenanceMode(mode),
      };
    });
  }

  async heartbeat(agent: OnecAgentContext, body: unknown): Promise<void> {
    const input = parseBody(heartbeatSchema, body);
    if (input.agentId !== agent.agentId) {
      throw new ApiError(400, 'AGENT_ID_MISMATCH', 'agentId in body does not match the authenticated agent');
    }
    await this.repository.transaction(async (tx) => {
      const previous = await this.repository.getStatus(tx, agent.agentId, true);
      const stateReason = input.stateReason ?? null;
      const changed = !previous || previous.state !== input.state || previous.stateReason !== stateReason;
      const sampleDue =
        changed || !previous?.historyWrittenAt || Date.now() - previous.historyWrittenAt.getTime() >= HISTORY_SAMPLE_MS;
      await this.repository.upsertStatus(tx, {
        agentId: agent.agentId,
        agentVersion: input.version,
        state: input.state,
        stateReason,
        heartbeat: whitelistHeartbeat(input),
        activeConfigVersion: input.activeConfigVersion ?? null,
        rejectedConfigVersion: input.rejectedConfigVersion ?? null,
        rejectedReason: input.rejectedReason ?? null,
        certExpiresAt: input.certificate?.expiresAtUtc ?? null,
        writeHistory: sampleDue,
      });
      if (sampleDue) {
        await this.repository.insertStatusHistory(tx, {
          agentId: agent.agentId,
          state: input.state,
          stateReason,
          summary: historySummary(input),
        });
      }
      await this.repository.touchLatestSession(tx, agent.agentId);
      await this.repository.clearPublishBlockIfFresh(tx, agent.agentId);
      // A heartbeat ends any "silent" period.
      await this.repository.resolveAlerts(tx, agent.agentId, ['agent_silent']);
      if (changed) {
        await this.repository.insertOutboxEvent(
          tx,
          buildOnecEvent({
            ...agentEventBase(agent),
            eventType: 'onec.agent.state_changed',
            severity: input.state === 'healthy' || input.state === 'maintenance' ? 'info' : input.state === 'degraded' ? 'warning' : 'critical',
            subject: { type: 'onec_agent', id: agent.agentId },
            data: { state: input.state, stateReason, previousState: previous?.state ?? null },
            idempotencyKey: `onec.agent.state_changed:${agent.agentId}:${agent.requestId}`,
          }),
        );
      }
      if (input.rejectedConfigVersion) {
        await this.repository.insertOutboxEvent(
          tx,
          buildOnecEvent({
            ...agentEventBase(agent),
            eventType: 'onec.config.rejected',
            severity: 'critical',
            subject: { type: 'onec_agent_config_version', id: `${agent.agentId}:${input.rejectedConfigVersion}` },
            data: { rejectedConfigVersion: input.rejectedConfigVersion, rejectedReason: input.rejectedReason ?? null },
            idempotencyKey: `onec.config.rejected:${agent.agentId}:${input.rejectedConfigVersion}`,
          }),
        );
      }
      await this.checkIdentity(tx, agent, input.sourceIdentity ?? null);
    });
  }

  async configuration(agent: OnecAgentContext, currentVersionRaw: unknown): Promise<ConfigurationResponse> {
    const currentVersion = parseCurrentVersion(currentVersionRaw);
    const published = await this.repository.getPublishedConfig(this.repository.db, agent.agentId);
    if (!published || published.configVersion === currentVersion) return { notModified: true };
    // Build the envelope by hand so the stored canonical bytes are sent verbatim.
    const body = `{"configVersion":${published.configVersion},"configHash":${JSON.stringify(published.configHash)},"configuration":${published.configurationCanonical}}`;
    return { notModified: false, body };
  }

  /**
   * First identity binds the source; a later mismatch flags identity_changed
   * (ETL is refused until an operator resolves it, see plan §3.2).
   */
  private async checkIdentity(
    tx: DatabaseClient,
    agent: OnecAgentContext,
    identity: Identity | null,
  ): Promise<SourceRecord['identityStatus']> {
    const source = await this.repository.getSource(tx, agent.sourceId, true);
    if (!source) throw new ApiError(403, 'SOURCE_UNKNOWN', 'Source is not registered');
    if (!identity) return source.identityStatus;
    // What the operator confirms on rebaseline is the identity reported last, by either channel.
    await this.repository.recordObservedIdentity(tx, source.sourceId, identity);
    if (source.identityStatus === 'unverified' || !source.identity) {
      await this.repository.bindSourceIdentity(tx, source.sourceId, identity, 'bound');
      await this.audit.byAgent(
        tx,
        agent,
        {
          event: 'onec.source.identity_bound',
          entityType: 'onec_source',
          entityId: source.sourceId,
          after: { databaseId: identity.databaseId, exportEpoch: identity.exportEpoch, environment: identity.environment },
        },
        { sourceGeneration: source.generation },
      );
      return 'bound';
    }
    if (source.identityStatus === 'bound' && !sameSourceIdentity(source.identity, identity)) {
      await this.repository.markIdentityChanged(tx, source.sourceId);
      await this.repository.recordIncident(tx, {
        agentId: agent.agentId,
        kind: 'source_identity_changed',
        dedupeKey: `source_identity_changed:${source.sourceId}:${identity.databaseId}:${identity.exportEpoch}:${identity.environment}`,
        details: { sourceId: source.sourceId, expected: source.identity, received: identity },
      });
      await this.audit.byAgent(
        tx,
        agent,
        {
          event: 'onec.source.identity_changed',
          entityType: 'onec_source',
          entityId: source.sourceId,
          before: { ...source.identity },
          after: { ...identity },
        },
        { sourceGeneration: source.generation },
      );
      await this.repository.insertOutboxEvent(
        tx,
        buildOnecEvent({
          ...agentEventBase(agent),
          eventType: 'onec.source.identity_changed',
          severity: 'critical',
          subject: { type: 'onec_source', id: String(source.sourceId) },
          data: { sourceGeneration: source.generation },
          idempotencyKey: `onec.source.identity_changed:${source.sourceId}:${identity.databaseId}:${identity.exportEpoch}:${identity.environment}`,
        }),
      );
      return 'identity_changed';
    }
    return source.identityStatus;
  }
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Invalid request body', {
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function parseCurrentVersion(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value);
  if (!/^[0-9]{1,18}$/.test(text)) throw new ApiError(400, 'INVALID_REQUEST', 'currentVersion must be a non-negative integer');
  return Number(text);
}

function modeOf(canonical: string): OnecAgentMode {
  const value = toPlainValue(parseStrictJson(canonical)) as { mode?: OnecAgentMode };
  return value.mode ?? 'Normal';
}

function whitelistHeartbeat(input: HeartbeatRequest): Record<string, unknown> {
  return {
    version: input.version,
    state: input.state,
    stateReason: input.stateReason ?? null,
    uptimeSeconds: input.uptimeSeconds ?? null,
    oneC: input.oneC ?? null,
    queues: input.queues ?? null,
    etl: input.etl ?? null,
    machine: input.machine ?? null,
    certificate: input.certificate ?? null,
  };
}

function historySummary(input: HeartbeatRequest): Record<string, unknown> {
  return {
    version: input.version,
    odataAvailable: input.oneC?.odataAvailable ?? null,
    commandApiAvailable: input.oneC?.commandApiAvailable ?? null,
    queues: input.queues ?? null,
    diskFreeBytes: input.machine?.diskFreeBytes ?? null,
  };
}
