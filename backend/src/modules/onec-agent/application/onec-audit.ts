import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../../common/audit/audit.service';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOnecRepository, type AuditLinkInput } from '../adapters/pg-onec-repository';

export const ONEC_ADMIN_AUDIT_SOURCE = 'erp_1c_admin';
export const ONEC_AGENT_AUDIT_SOURCE = 'erp_1c_agent';

/** Request identifiers of an admin API call (X-Request-Id / X-Correlation-Id). */
export interface OnecRequestContext {
  requestId: string;
  correlationId: string | null;
}

/** Identity of the calling agent, established by OnecAgentAuthGuard. */
export interface OnecAgentContext {
  agentId: string;
  sourceId: number;
  certId: number;
  requestId: string;
  correlationId: string | null;
}

/**
 * Writes audit_log and its normalized 1C dimensions (onec_audit_links) in the
 * caller's transaction. Payloads, certificates and secrets never go into
 * before/after/diff: only identifiers, hashes, versions and codes.
 */
@Injectable()
export class OnecAuditWriter {
  constructor(@Inject(PgOnecRepository) private readonly repository: PgOnecRepository) {}

  async byUser(
    tx: DatabaseClient,
    actor: CurrentUser,
    context: OnecRequestContext,
    event: Omit<AuditEvent, 'actorUserId' | 'actorUsername' | 'actorRole' | 'requestId' | 'source'>,
    link: Omit<AuditLinkInput, 'actorKind' | 'requestId' | 'correlationId'>,
  ): Promise<string> {
    const { requestId, correlationId } = context;
    const auditId = await auditService.record(tx, {
      ...event,
      actorUserId: actor.id,
      actorUsername: actor.username,
      actorRole: actor.role,
      requestId,
      source: ONEC_ADMIN_AUDIT_SOURCE,
    });
    await this.repository.insertAuditLink(tx, auditId, { ...link, actorKind: 'user', requestId, correlationId });
    return auditId;
  }

  async byAgent(
    tx: DatabaseClient,
    agent: OnecAgentContext,
    event: Omit<AuditEvent, 'actorUserId' | 'actorUsername' | 'actorRole' | 'requestId' | 'source'>,
    link: Omit<AuditLinkInput, 'actorKind' | 'agentId' | 'requestId' | 'correlationId'> = {},
  ): Promise<string> {
    const auditId = await auditService.record(tx, {
      ...event,
      actorUserId: null,
      actorUsername: `onec-agent:${agent.agentId}`,
      actorRole: null,
      requestId: agent.requestId,
      source: ONEC_AGENT_AUDIT_SOURCE,
    });
    await this.repository.insertAuditLink(tx, auditId, {
      sourceId: agent.sourceId,
      certId: agent.certId,
      ...link,
      actorKind: 'onec_agent',
      agentId: agent.agentId,
      requestId: agent.requestId,
      correlationId: agent.correlationId,
    });
    return auditId;
  }
}
