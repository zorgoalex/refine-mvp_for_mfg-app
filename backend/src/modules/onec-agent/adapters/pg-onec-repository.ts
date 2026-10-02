import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';

/** All SQL of the 1C agent module (E1). Every agent-scoped query filters by agent_id. */

export interface CertificateMatch {
  certId: number;
  agentId: string;
  sourceId: number;
  agentStatus: 'active' | 'blocked';
}

export interface AgentRecord {
  agentId: string;
  sourceId: number;
  siteId: string;
  displayName: string;
  status: 'active' | 'blocked';
  minimumAgentVersion: string;
  configPublishBlocked: boolean;
  version: number;
}

export interface SourceRecord {
  sourceId: number;
  code: string;
  displayName: string;
  identity: { databaseId: string; exportEpoch: string; environment: string } | null;
  identityStatus: 'unverified' | 'bound' | 'identity_changed';
  generation: number;
  /** Never-reused generation reference; published to the agent as configuration.sourceGeneration. */
  generationRef: string;
  /** Identity the agent reported last (session or heartbeat). */
  observedIdentity: { databaseId: string; exportEpoch: string; environment: string } | null;
}

export interface PublishedConfig {
  configVersion: number;
  configurationCanonical: string;
  configHash: string;
}

export interface StatusRecord {
  receivedAt: Date;
  state: string;
  stateReason: string | null;
  historyWrittenAt: Date | null;
}

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface OutboxEventRecord {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface AuditLinkInput {
  actorKind: 'user' | 'onec_agent' | 'system';
  agentId?: string | null;
  sourceId?: number | null;
  sourceGeneration?: number | null;
  configVersion?: number | null;
  commandId?: string | null;
  runId?: string | null;
  batchId?: string | null;
  sessionId?: string | null;
  certId?: number | null;
  requestId?: string | null;
  correlationId?: string | null;
}

export interface AlertUpsert {
  kind: string;
  agentId: string | null;
  sourceId: number | null;
  certId: number | null;
  severity: 'info' | 'warning' | 'critical';
  dedupeKey: string;
  details: Record<string, unknown>;
  /** One alert per fact: inserted once, never reopened by a replayed event. */
  oneShot?: boolean;
}

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toAgent(row: QueryResultRow): AgentRecord {
  return {
    agentId: row.agent_id,
    sourceId: num(row.source_id),
    siteId: row.site_id,
    displayName: row.display_name,
    status: row.status,
    minimumAgentVersion: row.minimum_agent_version,
    configPublishBlocked: row.config_publish_blocked,
    version: num(row.version),
  };
}

function toSource(row: QueryResultRow): SourceRecord {
  return {
    sourceId: num(row.source_id),
    code: row.code,
    displayName: row.display_name,
    identity: row.identity ?? null,
    identityStatus: row.identity_status,
    generation: num(row.generation),
    generationRef: row.generation_ref,
    observedIdentity: row.observed_identity ?? null,
  };
}

@Injectable()
export class PgOnecRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.database.transaction(handler);
  }

  get db(): DatabaseClient {
    return this.database;
  }

  // ---------------------------------------------------------------- agent auth

  async findActiveCertificate(fingerprint: Buffer): Promise<CertificateMatch | null> {
    const { rows } = await this.database.query(
      `SELECT c.cert_id, c.agent_id, a.source_id, a.status AS agent_status
         FROM onec_agent_certificates c
         JOIN onec_agents a ON a.agent_id = c.agent_id
        WHERE c.sha256_fingerprint = $1
          AND c.status = 'active'
          AND (c.not_before IS NULL OR c.not_before <= now())
          AND (c.not_after IS NULL OR c.not_after > now())`,
      [fingerprint],
    );
    const row = rows[0];
    if (!row) return null;
    return { certId: num(row.cert_id), agentId: row.agent_id, sourceId: num(row.source_id), agentStatus: row.agent_status };
  }

  // ---------------------------------------------------------------- sessions / config

  async getAgent(client: DatabaseClient, agentId: string, forUpdate = false): Promise<AgentRecord | null> {
    const { rows } = await client.query(
      `SELECT * FROM onec_agents WHERE agent_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [agentId],
    );
    return rows[0] ? toAgent(rows[0]) : null;
  }

  /**
   * `lock`: `true` — FOR UPDATE (admin source operations); `'no_key'` — FOR NO KEY UPDATE (as rebaseline): serializes writers of
   * non-key columns (agent identity check on heartbeat/session) but, unlike FOR UPDATE, does not wait for the FOR KEY SHARE
   * locks every insert referencing the source takes (e.g. an ETL `complete` publishing thousands of mirror rows).
   */
  async getSource(client: DatabaseClient, sourceId: number, lock: boolean | 'no_key' = false): Promise<SourceRecord | null> {
    const clause = lock === 'no_key' ? 'FOR NO KEY UPDATE' : lock ? 'FOR UPDATE' : '';
    const { rows } = await client.query(
      `SELECT * FROM onec_sources WHERE source_id = $1 ${clause}`,
      [sourceId],
    );
    return rows[0] ? toSource(rows[0]) : null;
  }

  async bindSourceIdentity(
    client: DatabaseClient,
    sourceId: number,
    identity: SourceRecord['identity'],
    status: SourceRecord['identityStatus'],
  ): Promise<void> {
    await client.query(
      `UPDATE onec_sources SET identity = $2::jsonb, identity_status = $3, updated_at = now() WHERE source_id = $1`,
      [sourceId, identity ? JSON.stringify(identity) : null, status],
    );
  }

  async markIdentityChanged(client: DatabaseClient, sourceId: number): Promise<void> {
    await client.query(
      `UPDATE onec_sources SET identity_status = 'identity_changed', updated_at = now() WHERE source_id = $1`,
      [sourceId],
    );
  }

  async createSession(
    client: DatabaseClient,
    input: {
      agentId: string;
      agentVersion: string;
      localSchemaVersion: number | null;
      capabilities: string[];
      accepted: boolean;
      sourceIdentity: unknown;
    },
  ): Promise<{ sessionId: string; startedAt: Date }> {
    const { rows } = await client.query(
      `INSERT INTO onec_agent_sessions (agent_id, agent_version, local_schema_version, capabilities, accepted, source_identity)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING session_id, started_at`,
      [
        input.agentId,
        input.agentVersion,
        input.localSchemaVersion,
        input.capabilities,
        input.accepted,
        input.sourceIdentity ? JSON.stringify(input.sourceIdentity) : null,
      ],
    );
    return { sessionId: rows[0]!.session_id, startedAt: rows[0]!.started_at };
  }

  async getPublishedConfig(client: DatabaseClient, agentId: string): Promise<PublishedConfig | null> {
    const { rows } = await client.query(
      `SELECT config_version, configuration_canonical, config_hash
         FROM onec_agent_config_versions WHERE agent_id = $1 AND status = 'published'`,
      [agentId],
    );
    const row = rows[0];
    return row
      ? { configVersion: num(row.config_version), configurationCanonical: row.configuration_canonical, configHash: row.config_hash }
      : null;
  }

  // ---------------------------------------------------------------- heartbeat

  async getStatus(client: DatabaseClient, agentId: string, forUpdate = false): Promise<StatusRecord | null> {
    const { rows } = await client.query(
      `SELECT received_at, state, state_reason, history_written_at FROM onec_agent_status WHERE agent_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [agentId],
    );
    const row = rows[0];
    return row
      ? { receivedAt: row.received_at, state: row.state, stateReason: row.state_reason, historyWrittenAt: row.history_written_at }
      : null;
  }

  async upsertStatus(
    client: DatabaseClient,
    input: {
      agentId: string;
      agentVersion: string;
      state: string;
      stateReason: string | null;
      heartbeat: Record<string, unknown>;
      activeConfigVersion: number | null;
      rejectedConfigVersion: number | null;
      rejectedReason: string | null;
      certExpiresAt: string | null;
      writeHistory: boolean;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO onec_agent_status (agent_id, received_at, agent_version, state, state_reason, heartbeat,
                                      active_config_version, rejected_config_version, rejected_reason,
                                      cert_expires_at, history_written_at)
       VALUES ($1, now(), $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz, CASE WHEN $10 THEN now() END)
       ON CONFLICT (agent_id) DO UPDATE SET
         received_at = now(), agent_version = EXCLUDED.agent_version, state = EXCLUDED.state,
         state_reason = EXCLUDED.state_reason, heartbeat = EXCLUDED.heartbeat,
         active_config_version = EXCLUDED.active_config_version,
         rejected_config_version = EXCLUDED.rejected_config_version,
         rejected_reason = EXCLUDED.rejected_reason, cert_expires_at = EXCLUDED.cert_expires_at,
         history_written_at = CASE WHEN $10 THEN now() ELSE onec_agent_status.history_written_at END`,
      [
        input.agentId,
        input.agentVersion,
        input.state,
        input.stateReason,
        JSON.stringify(input.heartbeat),
        input.activeConfigVersion,
        input.rejectedConfigVersion,
        input.rejectedReason,
        input.certExpiresAt,
        input.writeHistory,
      ],
    );
  }

  async insertStatusHistory(
    client: DatabaseClient,
    input: { agentId: string; state: string; stateReason: string | null; summary: Record<string, unknown> },
  ): Promise<void> {
    await client.query(
      `INSERT INTO onec_agent_status_history (agent_id, state, state_reason, summary) VALUES ($1, $2, $3, $4::jsonb)`,
      [input.agentId, input.state, input.stateReason, JSON.stringify(input.summary)],
    );
  }

  async touchLatestSession(client: DatabaseClient, agentId: string): Promise<void> {
    await client.query(
      `UPDATE onec_agent_sessions SET last_seen_at = now()
        WHERE session_id = (SELECT session_id FROM onec_agent_sessions WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 1)`,
      [agentId],
    );
  }

  /** Clears the post-restore publication block once a fresh heartbeat arrived. */
  async clearPublishBlockIfFresh(client: DatabaseClient, agentId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE onec_agents SET config_publish_blocked = false, config_publish_blocked_at = NULL, updated_at = now()
        WHERE agent_id = $1 AND config_publish_blocked AND config_publish_blocked_at < now()`,
      [agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- admin: sources & agents

  async listSources(): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT s.source_id, s.code, s.display_name, s.identity, s.identity_status, s.generation,
              s.observed_identity, s.created_at, s.updated_at, a.agent_id
         FROM onec_sources s LEFT JOIN onec_agents a ON a.source_id = s.source_id
        ORDER BY s.source_id`,
    );
    return rows;
  }

  async insertSource(client: DatabaseClient, input: { code: string; displayName: string; actorId: number }): Promise<SourceRecord> {
    const { rows } = await client.query(
      `INSERT INTO onec_sources (code, display_name, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING *`,
      [input.code, input.displayName, input.actorId],
    );
    return toSource(rows[0]!);
  }

  async updateSourceName(client: DatabaseClient, sourceId: number, displayName: string, actorId: number): Promise<SourceRecord | null> {
    const { rows } = await client.query(
      `UPDATE onec_sources SET display_name = $2, updated_by = $3, updated_at = now() WHERE source_id = $1 RETURNING *`,
      [sourceId, displayName, actorId],
    );
    return rows[0] ? toSource(rows[0]) : null;
  }

  async listAgents(): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT a.agent_id, a.source_id, s.display_name AS source_name, s.code AS source_code,
              s.identity_status, s.identity, s.observed_identity, s.generation AS source_generation, a.site_id, a.display_name, a.status,
              a.minimum_agent_version, a.config_publish_blocked, a.version, a.created_at, a.updated_at,
              st.received_at, st.agent_version, st.state, st.state_reason, st.heartbeat,
              st.active_config_version, st.rejected_config_version, st.rejected_reason, st.cert_expires_at,
              cv.config_version AS published_config_version,
              (SELECT min(c.not_after) FROM onec_agent_certificates c
                WHERE c.agent_id = a.agent_id AND c.status = 'active') AS nearest_cert_not_after,
              (SELECT count(*) FROM onec_agent_certificates c
                WHERE c.agent_id = a.agent_id AND c.status = 'active') AS active_cert_count,
              (SELECT count(*) FROM onec_alerts al
                WHERE al.agent_id = a.agent_id AND al.state = 'open') AS open_alert_count
         FROM onec_agents a
         JOIN onec_sources s ON s.source_id = a.source_id
         LEFT JOIN onec_agent_status st ON st.agent_id = a.agent_id
         LEFT JOIN onec_agent_config_versions cv ON cv.agent_id = a.agent_id AND cv.status = 'published'
        ORDER BY a.display_name, a.agent_id`,
    );
    return rows;
  }

  async insertAgent(
    client: DatabaseClient,
    input: { agentId: string; sourceId: number; siteId: string; displayName: string; minimumAgentVersion: string; actorId: number },
  ): Promise<AgentRecord> {
    const { rows } = await client.query(
      `INSERT INTO onec_agents (agent_id, source_id, site_id, display_name, minimum_agent_version, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [input.agentId, input.sourceId, input.siteId, input.displayName, input.minimumAgentVersion, input.actorId],
    );
    return toAgent(rows[0]!);
  }

  async updateAgent(
    client: DatabaseClient,
    agentId: string,
    patch: { siteId?: string; displayName?: string; minimumAgentVersion?: string; status?: 'active' | 'blocked' },
    actorId: number,
  ): Promise<AgentRecord> {
    const { rows } = await client.query(
      `UPDATE onec_agents SET
          site_id = COALESCE($2, site_id),
          display_name = COALESCE($3, display_name),
          minimum_agent_version = COALESCE($4, minimum_agent_version),
          status = COALESCE($5, status),
          version = version + 1, updated_by = $6, updated_at = now()
        WHERE agent_id = $1 RETURNING *`,
      [agentId, patch.siteId ?? null, patch.displayName ?? null, patch.minimumAgentVersion ?? null, patch.status ?? null, actorId],
    );
    return toAgent(rows[0]!);
  }

  // ---------------------------------------------------------------- admin: certificates

  async listCertificates(agentId: string): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT cert_id, agent_id, sha256_fingerprint, subject, not_before, not_after, status,
              added_at, added_by, revoked_at, revoked_by
         FROM onec_agent_certificates WHERE agent_id = $1 ORDER BY added_at DESC, cert_id DESC`,
      [agentId],
    );
    return rows;
  }

  async insertCertificate(
    client: DatabaseClient,
    input: { agentId: string; fingerprint: Buffer; subject: string | null; notBefore: Date | null; notAfter: Date | null; actorId: number },
  ): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `INSERT INTO onec_agent_certificates (agent_id, sha256_fingerprint, subject, not_before, not_after, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sha256_fingerprint) DO NOTHING
       RETURNING *`,
      [input.agentId, input.fingerprint, input.subject, input.notBefore, input.notAfter, input.actorId],
    );
    return rows[0] ?? null;
  }

  async revokeCertificate(client: DatabaseClient, agentId: string, certId: number, actorId: number): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `UPDATE onec_agent_certificates SET status = 'revoked', revoked_at = now(), revoked_by = $3
        WHERE agent_id = $1 AND cert_id = $2 AND status = 'active' RETURNING *`,
      [agentId, certId, actorId],
    );
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- admin: configuration

  async recordObservedIdentity(client: DatabaseClient, sourceId: number, identity: NonNullable<SourceRecord['identity']>): Promise<void> {
    await client.query(
      `UPDATE onec_sources SET observed_identity = $2::jsonb, observed_identity_at = now()
        WHERE source_id = $1 AND observed_identity IS DISTINCT FROM $2::jsonb`,
      [sourceId, JSON.stringify({ databaseId: identity.databaseId, exportEpoch: identity.exportEpoch, environment: identity.environment })],
    );
  }

  /**
   * Rebaseline/revocation locks (plan §3.2, §21.3): FOR NO KEY UPDATE on the agent and the source, so the foreign-key
   * KEY SHARE locks taken by concurrent ETL inserts (runs, batches, mirror rows) never wait on them.
   */
  async lockForRebaseline(tx: DatabaseClient, sourceId: number): Promise<{ agent: AgentRecord | null; source: SourceRecord | null }> {
    const agent = await tx.query(`SELECT * FROM onec_agents WHERE source_id = $1 FOR NO KEY UPDATE`, [sourceId]);
    const source = await tx.query(`SELECT * FROM onec_sources WHERE source_id = $1 FOR NO KEY UPDATE`, [sourceId]);
    return { agent: agent.rows[0] ? toAgent(agent.rows[0]) : null, source: source.rows[0] ? toSource(source.rows[0]) : null };
  }

  async getDraft(client: DatabaseClient, agentId: string, forUpdate = false): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `SELECT agent_id, revision, configuration_canonical, config_hash, updated_at, updated_by
         FROM onec_agent_config_drafts WHERE agent_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [agentId],
    );
    return rows[0] ?? null;
  }

  async upsertDraft(
    client: DatabaseClient,
    input: { agentId: string; expectedRevision: number | null; canonical: string; hash: string; actorId: number },
  ): Promise<QueryResultRow | null> {
    if (input.expectedRevision === null) {
      const { rows } = await client.query(
        `INSERT INTO onec_agent_config_drafts (agent_id, revision, configuration_canonical, config_hash, updated_by)
         VALUES ($1, 1, $2, $3, $4) ON CONFLICT (agent_id) DO NOTHING RETURNING *`,
        [input.agentId, input.canonical, input.hash, input.actorId],
      );
      return rows[0] ?? null;
    }
    const { rows } = await client.query(
      `UPDATE onec_agent_config_drafts SET revision = revision + 1, configuration_canonical = $3, config_hash = $4,
              updated_by = $5, updated_at = now()
        WHERE agent_id = $1 AND revision = $2 RETURNING *`,
      [input.agentId, input.expectedRevision, input.canonical, input.hash, input.actorId],
    );
    return rows[0] ?? null;
  }

  /** Highest config version the agent is known to have seen (table + agent-reported). */
  async configVersionFloor(client: DatabaseClient, agentId: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT GREATEST(
          COALESCE((SELECT max(config_version) FROM onec_agent_config_versions WHERE agent_id = $1), 0),
          COALESCE((SELECT GREATEST(COALESCE(active_config_version, 0), COALESCE(rejected_config_version, 0))
                      FROM onec_agent_status WHERE agent_id = $1), 0)) AS floor`,
      [agentId],
    );
    return num(rows[0]?.floor ?? 0);
  }

  async publishConfigVersion(
    client: DatabaseClient,
    input: { agentId: string; configVersion: number; canonical: string; hash: string; revision: number; actorId: number },
  ): Promise<void> {
    await client.query(
      `UPDATE onec_agent_config_versions SET status = 'superseded' WHERE agent_id = $1 AND status = 'published'`,
      [input.agentId],
    );
    await client.query(
      `INSERT INTO onec_agent_config_versions (agent_id, config_version, status, configuration_canonical, config_hash,
                                               published_from_revision, published_by)
       VALUES ($1, $2, 'published', $3, $4, $5, $6)`,
      [input.agentId, input.configVersion, input.canonical, input.hash, input.revision, input.actorId],
    );
  }

  async listConfigVersions(agentId: string): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT v.config_version, v.status, v.config_hash, v.published_from_revision, v.published_at,
              v.published_by, u.username AS published_by_name, v.configuration_canonical
         FROM onec_agent_config_versions v LEFT JOIN users u ON u.user_id = v.published_by
        WHERE v.agent_id = $1 ORDER BY v.config_version DESC LIMIT 100`,
      [agentId],
    );
    return rows;
  }

  async listStatusHistory(agentId: string, limit: number): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT at, state, state_reason, summary FROM onec_agent_status_history
        WHERE agent_id = $1 ORDER BY at DESC, history_id DESC LIMIT $2`,
      [agentId, limit],
    );
    return rows;
  }

  // ---------------------------------------------------------------- incidents & alerts

  async recordIncident(
    client: DatabaseClient,
    input: { agentId: string | null; kind: string; dedupeKey: string; details: Record<string, unknown>; runId?: string | null; batchId?: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO onec_agent_incidents (agent_id, kind, dedupe_key, details, run_id, batch_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (dedupe_key) DO UPDATE SET occurrences = onec_agent_incidents.occurrences + 1,
         last_at = now(), details = EXCLUDED.details`,
      [input.agentId, input.kind, input.dedupeKey, JSON.stringify(input.details), input.runId ?? null, input.batchId ?? null],
    );
  }

  async listIncidents(filter: { agentId?: string; open?: boolean; limit: number }): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT incident_id, agent_id, kind, details, occurrences, first_at, last_at, resolved_at, resolved_by
         FROM onec_agent_incidents
        WHERE ($1::text IS NULL OR agent_id = $1) AND ($2::boolean IS NULL OR (resolved_at IS NULL) = $2)
        ORDER BY last_at DESC, incident_id DESC LIMIT $3`,
      [filter.agentId ?? null, filter.open ?? null, filter.limit],
    );
    return rows;
  }

  async resolveIncident(client: DatabaseClient, incidentId: number, actorId: number): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `UPDATE onec_agent_incidents SET resolved_at = now(), resolved_by = $2
        WHERE incident_id = $1 AND resolved_at IS NULL RETURNING *`,
      [incidentId, actorId],
    );
    return rows[0] ?? null;
  }

  async upsertAlert(client: DatabaseClient, alert: AlertUpsert): Promise<void> {
    if (alert.oneShot) {
      // One alert per fact (e.g. one command): a replayed event never reopens or rewrites it.
      await client.query(
        `INSERT INTO onec_alerts (kind, agent_id, source_id, cert_id, severity, dedupe_key, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (dedupe_key) DO NOTHING`,
        [alert.kind, alert.agentId, alert.sourceId, alert.certId, alert.severity, alert.dedupeKey, JSON.stringify(alert.details)],
      );
      return;
    }
    await client.query(
      `INSERT INTO onec_alerts (kind, agent_id, source_id, cert_id, severity, dedupe_key, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET last_seen_at = now(), details = EXCLUDED.details,
         severity = EXCLUDED.severity,
         -- A condition that returns reopens its alert (acknowledged stays acknowledged).
         state = CASE WHEN onec_alerts.state = 'resolved' THEN 'open' ELSE onec_alerts.state END,
         opened_at = CASE WHEN onec_alerts.state = 'resolved' THEN now() ELSE onec_alerts.opened_at END,
         resolved_at = CASE WHEN onec_alerts.state = 'resolved' THEN NULL ELSE onec_alerts.resolved_at END`,
      [alert.kind, alert.agentId, alert.sourceId, alert.certId, alert.severity, alert.dedupeKey, JSON.stringify(alert.details)],
    );
  }

  /**
   * Locks the command row (same lock as received/result) and tells whether the agent
   * got it, so an "undelivered" alert is never created after a late receipt.
   */
  async commandReceivedForUpdate(client: DatabaseClient, commandId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT received_at IS NOT NULL AS received FROM onec_agent_commands WHERE command_id = $1 FOR UPDATE`,
      [commandId],
    );
    return rows[0]?.received === true;
  }

  async resolveAlertByDedupeKey(client: DatabaseClient, dedupeKey: string): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE onec_alerts SET state = 'resolved', resolved_at = now() WHERE dedupe_key = $1 AND state <> 'resolved'`,
      [dedupeKey],
    );
    return rowCount ?? 0;
  }

  /** Operator closes a one-shot alert (the fact was handled); only resolvable kinds, never state-projected ones. */
  async resolveAlert(client: DatabaseClient, alertId: number, kinds: readonly string[]): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `UPDATE onec_alerts SET state = 'resolved', resolved_at = now()
        WHERE alert_id = $1 AND kind = ANY($2::text[]) AND state <> 'resolved' RETURNING *`,
      [alertId, kinds],
    );
    return rows[0] ?? null;
  }

  /** Resolves open alerts of the given kinds for an agent (the condition cleared), except `keepDedupeKey`. */
  async resolveAlerts(client: DatabaseClient, agentId: string, kinds: readonly string[], keepDedupeKey: string | null = null): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE onec_alerts SET state = 'resolved', resolved_at = now()
        WHERE agent_id = $1 AND kind = ANY($2::text[]) AND state <> 'resolved'
          AND ($3::text IS NULL OR dedupe_key <> $3)`,
      [agentId, kinds, keepDedupeKey],
    );
    return rowCount ?? 0;
  }

  async listAlerts(filter: { agentId?: string; state?: string; limit: number }): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT al.alert_id, al.kind, al.agent_id, a.display_name AS agent_name, al.source_id, al.cert_id,
              al.severity, al.state, al.details, al.opened_at, al.last_seen_at, al.acknowledged_at,
              al.acknowledged_by, al.resolved_at
         FROM onec_alerts al LEFT JOIN onec_agents a ON a.agent_id = al.agent_id
        WHERE ($1::text IS NULL OR al.agent_id = $1) AND ($2::text IS NULL OR al.state = $2)
        ORDER BY (al.state = 'open') DESC, al.last_seen_at DESC, al.alert_id DESC LIMIT $3`,
      [filter.agentId ?? null, filter.state ?? null, filter.limit],
    );
    return rows;
  }

  async acknowledgeAlert(client: DatabaseClient, alertId: number, actorId: number): Promise<QueryResultRow | null> {
    const { rows } = await client.query(
      `UPDATE onec_alerts SET state = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
        WHERE alert_id = $1 AND state = 'open' RETURNING *`,
      [alertId, actorId],
    );
    return rows[0] ?? null;
  }

  async countOpenAlerts(): Promise<number> {
    const { rows } = await this.database.query(`SELECT count(*) AS n FROM onec_alerts WHERE state = 'open'`);
    return num(rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------- outbox

  async insertOutboxEvent(client: DatabaseClient, event: OutboxEventInput): Promise<void> {
    await client.query(
      `INSERT INTO onec_outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [event.eventType, event.aggregateType, event.aggregateId, JSON.stringify(event.payload), event.idempotencyKey],
    );
  }

  async claimOutboxEvents(workerId: string, batchSize: number, staleLockMs: number): Promise<OutboxEventRecord[]> {
    const { rows } = await this.database.query(
      `UPDATE onec_outbox_events SET status = 'processing', locked_at = now(), locked_by = $1
        WHERE event_id IN (
          SELECT event_id FROM onec_outbox_events
           WHERE (status = 'pending' AND next_attempt_at <= now())
              OR (status = 'processing' AND locked_at < now() - ($3::int * interval '1 millisecond'))
           ORDER BY event_id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING event_id, event_type, payload_json, attempts`,
      [workerId, batchSize, staleLockMs],
    );
    return rows.map((row) => ({
      eventId: String(row.event_id),
      eventType: row.event_type,
      payload: row.payload_json ?? {},
      attempts: num(row.attempts),
    }));
  }

  async markOutboxProcessed(client: DatabaseClient, eventId: string, workerId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE onec_outbox_events SET status = 'processed', processed_at = now(), locked_at = NULL, locked_by = NULL
        WHERE event_id = $1 AND status = 'processing' AND locked_by = $2`,
      [eventId, workerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async markOutboxRetry(eventId: string, workerId: string, error: string, maxAttempts: number): Promise<void> {
    await this.database.query(
      `UPDATE onec_outbox_events SET attempts = attempts + 1, last_error = left($3, 500),
              status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
              next_attempt_at = now() + least(power(2, attempts + 1), 300) * interval '1 second',
              locked_at = NULL, locked_by = NULL
        WHERE event_id = $1 AND status = 'processing' AND locked_by = $2`,
      [eventId, workerId, error, maxAttempts],
    );
  }

  // ---------------------------------------------------------------- audit links

  async insertAuditLink(client: DatabaseClient, auditId: string, link: AuditLinkInput): Promise<void> {
    await client.query(
      `INSERT INTO onec_audit_links (audit_id, actor_kind, agent_id, source_id, source_generation, config_version,
                                     session_id, cert_id, request_id, correlation_id, command_id, run_id, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        auditId,
        link.actorKind,
        link.agentId ?? null,
        link.sourceId ?? null,
        link.sourceGeneration ?? null,
        link.configVersion ?? null,
        link.sessionId ?? null,
        link.certId ?? null,
        link.requestId ?? null,
        link.correlationId ?? null,
        link.commandId ?? null,
        link.runId ?? null,
        link.batchId ?? null,
      ],
    );
  }

  // ---------------------------------------------------------------- monitor & retention

  async listAgentsForMonitor(): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT a.agent_id, a.source_id, a.status, st.received_at, st.state, st.state_reason, st.cert_expires_at
         FROM onec_agents a LEFT JOIN onec_agent_status st ON st.agent_id = a.agent_id
        WHERE a.status = 'active'`,
    );
    return rows;
  }

  async listExpiringCertificates(withinDays: number): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `SELECT c.cert_id, c.agent_id, a.source_id, c.not_after
         FROM onec_agent_certificates c JOIN onec_agents a ON a.agent_id = c.agent_id
        WHERE c.status = 'active' AND a.status = 'active' AND c.not_after IS NOT NULL
          AND c.not_after <= now() + ($1::int * interval '1 day')`,
      [withinDays],
    );
    return rows;
  }

  async applyRetention(): Promise<Record<string, number>> {
    const run = async (sql: string) => (await this.database.query(sql)).rowCount ?? 0;
    return {
      // Логи связи живут сутки (журнал за сутки, решение пользователя 2026-10-02); 25 ч — запас на почасовую очистку.
      sessions: await run(`DELETE FROM onec_agent_sessions WHERE last_seen_at < now() - interval '25 hours'`),
      statusHistory: await run(`DELETE FROM onec_agent_status_history WHERE at < now() - interval '25 hours'`),
      outbox: await run(`DELETE FROM onec_outbox_events WHERE status = 'processed' AND processed_at < now() - interval '30 days'`),
      // Incidents are aggregated per hour; unresolved ones also expire so floods cannot accumulate.
      incidents: await run(`DELETE FROM onec_agent_incidents WHERE resolved_at < now() - interval '180 days' OR last_at < now() - interval '90 days'`),
      alerts: await run(`DELETE FROM onec_alerts WHERE state = 'resolved' AND resolved_at < now() - interval '180 days'`),
    };
  }
}

export { numOrNull };
