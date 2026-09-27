import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { RateLimitService } from '../../../rate-limit/rate-limit.service';
import type { RateLimitConsumeInput } from '../../../rate-limit/rate-limit.types';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { ONEC_AGENT_AUDIT_SOURCE, type OnecAgentContext } from '../application/onec-audit';
import { fingerprintFromForwardedHeader } from '../domain/onec-certificates';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';

export const ONEC_ALLOW_BLOCKED_METADATA_KEY = 'onec:allow_blocked_agent';
export const INGRESS_AUTH_HEADER = 'x-onec-ingress-auth';

/** Failed authentication attempts per client IP (successes are refunded). */
const PREAUTH_FAILURE_RULE = { feature: 'onec_agent_auth_failures', maxRequests: 60, windowMs: 60_000 };
/** Authenticated requests per agent (heartbeat/config are ~1/min; long poll comes in E2). */
const AGENT_REQUEST_RULE = { feature: 'onec_agent_requests', maxRequests: 1200, windowMs: 60_000 };
/** At most one denied-audit row per (reason, trusted identity) per window. */
const DENIED_AUDIT_WINDOW_MS = 60_000;

type DenyReason = 'ingress_auth_failed' | 'cert_required' | 'unknown_certificate' | 'agent_cert_mismatch' | 'agent_blocked';

interface AgentRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { localPort?: number; remoteAddress?: string };
  requestId?: string;
  onecAgent?: OnecAgentContext;
}

const header = (request: AgentRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Authenticates the 1C agent (plan §4.2):
 * 1. the request arrived on the dedicated agent listener (else 404);
 * 2. it came through the Traefik mTLS router (ingress secret header);
 * 3. the forwarded client certificate is registered and active (no cache:
 *    revocation/blocking apply to the next request in every process);
 * 4. X-Agent-Id equals the certificate's agent;
 * 5. blocked agents are refused except on routes marked AllowBlockedAgent.
 * Every denial is recorded as an aggregated incident and a throttled
 * `onec.auth.denied` audit row; attacker-controlled values never form keys.
 */
@Injectable()
export class OnecAgentAuthGuard implements CanActivate {
  private readonly logger = new Logger(OnecAgentAuthGuard.name);
  private readonly deniedAuditAt = new Map<string, number>();

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.runtime.get();
    const request = context.switchToHttp().getRequest<AgentRequest>();
    if (!config.enabled || request.socket?.localPort !== config.agentPort) {
      throw new ApiError(404, 'NOT_FOUND', 'Not found');
    }
    const ids = {
      requestId: header(request, 'x-request-id')?.slice(0, 100) || request.requestId || 'onec-agent',
      correlationId: header(request, 'x-correlation-id')?.slice(0, 100) ?? null,
    };
    // Traefik sets X-Real-Ip on this router; the agent listener is reachable only through it.
    const clientIp = header(request, 'x-real-ip')?.slice(0, 64) || request.socket?.remoteAddress || 'unknown';
    const failureBudget: RateLimitConsumeInput = {
      rule: PREAUTH_FAILURE_RULE,
      subject: { route: 'onec-agent-auth', ipAddress: clientIp },
    };
    await this.rateLimit.assertAllowed(failureBudget);

    if (!matchesAnySecret(header(request, INGRESS_AUTH_HEADER), config.ingressSecrets)) {
      await this.deny('ingress_auth_failed', ids, {});
      throw new ApiError(403, 'FORBIDDEN', 'Forbidden');
    }
    const fingerprint = fingerprintFromForwardedHeader(header(request, config.clientCertHeader));
    if (!fingerprint) {
      await this.deny('cert_required', ids, {});
      throw new ApiError(403, 'CERT_REQUIRED', 'Client certificate required');
    }
    const match = await this.repository.findActiveCertificate(fingerprint);
    if (!match) {
      await this.deny('unknown_certificate', ids, { fingerprint: fingerprint.toString('hex') });
      throw new ApiError(403, 'CERT_UNKNOWN', 'Client certificate is not registered');
    }
    const claimedAgent = header(request, 'x-agent-id');
    if (claimedAgent !== match.agentId) {
      await this.deny('agent_cert_mismatch', ids, { agentId: match.agentId, sourceId: match.sourceId, certId: match.certId });
      throw new ApiError(403, 'AGENT_CERT_MISMATCH', 'X-Agent-Id does not match the client certificate');
    }
    const allowBlocked = this.reflector.getAllAndOverride<boolean>(ONEC_ALLOW_BLOCKED_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (match.agentStatus === 'blocked' && !allowBlocked) {
      await this.deny('agent_blocked', ids, { agentId: match.agentId, sourceId: match.sourceId, certId: match.certId });
      throw new ApiError(403, 'AGENT_BLOCKED', 'Agent is blocked');
    }
    await this.rateLimit.refund(failureBudget);
    await this.rateLimit.assertAllowed({
      rule: AGENT_REQUEST_RULE,
      subject: { route: 'onec-agent', resourceId: match.agentId },
    });
    request.onecAgent = { agentId: match.agentId, sourceId: match.sourceId, certId: match.certId, ...ids };
    return true;
  }

  /**
   * Keys use only trusted values (reason + registered agent/cert) and the hour,
   * so a flood of distinct forged headers cannot grow the tables.
   */
  private async deny(
    reason: DenyReason,
    ids: { requestId: string; correlationId: string | null },
    trusted: { agentId?: string; sourceId?: number; certId?: number; fingerprint?: string },
  ): Promise<void> {
    const hour = new Date().toISOString().slice(0, 13);
    const identity = trusted.certId !== undefined ? `cert:${trusted.certId}` : 'anonymous';
    try {
      await this.repository.recordIncident(this.repository.db, {
        agentId: trusted.agentId ?? null,
        kind: reason,
        dedupeKey: `${reason}:${identity}:${hour}`,
        details: { lastRequestId: ids.requestId, lastCorrelationId: ids.correlationId, lastFingerprint: trusted.fingerprint ?? null },
      });
      const throttleKey = `${reason}:${identity}`;
      const now = Date.now();
      if (now - (this.deniedAuditAt.get(throttleKey) ?? 0) < DENIED_AUDIT_WINDOW_MS) return;
      if (this.deniedAuditAt.size > 1000) this.deniedAuditAt.clear();
      this.deniedAuditAt.set(throttleKey, now);
      await this.repository.transaction(async (tx) => {
        const auditId = await auditService.recordDenied(tx, {
          event: 'onec.auth.denied',
          entityType: 'onec_agent',
          entityId: trusted.agentId ?? 'unknown',
          actorUserId: null,
          actorUsername: trusted.agentId ? `onec-agent:${trusted.agentId}` : null,
          actorRole: null,
          requestId: ids.requestId,
          source: ONEC_AGENT_AUDIT_SOURCE,
          reason,
          metadata: { correlationId: ids.correlationId, certId: trusted.certId ?? null, fingerprint: trusted.fingerprint ?? null },
        });
        await this.repository.insertAuditLink(tx, auditId, {
          actorKind: trusted.agentId ? 'onec_agent' : 'system',
          agentId: trusted.agentId ?? null,
          sourceId: trusted.sourceId ?? null,
          certId: trusted.certId ?? null,
          requestId: ids.requestId,
          correlationId: ids.correlationId,
        });
      });
    } catch (error) {
      // Denial bookkeeping must never turn a 403 into a 500.
      this.logger.warn(`1C auth denial bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function matchesAnySecret(value: string | undefined, secrets: readonly string[]): boolean {
  if (!value || secrets.length === 0) return false;
  const given = Buffer.from(value);
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(secret);
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}
