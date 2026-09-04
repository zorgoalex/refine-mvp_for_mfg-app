import { randomBytes } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PaymentAccessPolicy } from '../../../permissions/policies/payment-access.policy';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import {
  Bitrix24TokenCipher,
  matchesBitrix24ApplicationToken,
} from '../reverse/bitrix24-token-cipher';
import { parseWidgetCallback, type Bitrix24WidgetCallback } from './bitrix24-payment-widget.dto';
import {
  Bitrix24PaymentWidgetRepository,
  hashWidgetToken,
  type ActiveWidgetInstallation,
  type WidgetDealContext,
  type WidgetMappedUser,
  type WidgetSession,
} from './bitrix24-payment-widget.repository';

export interface AuthenticatedWidgetSession {
  session: WidgetSession;
  actor: CurrentUser;
  actorDisplayName: string;
  accessToken: string;
  refreshToken: string;
  installation: ActiveWidgetInstallation;
}

export class Bitrix24PaymentWidgetAuthService {
  private readonly paymentPolicy = new PaymentAccessPolicy();

  constructor(
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly permissions: PermissionsService,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly bitrix: Bitrix24LocalAppClient,
  ) {}

  async bootstrap(query: unknown, body: unknown): Promise<{
    token: string;
    dealId: string;
    actorDisplayName: string;
  }> {
    const settings = this.requireEnabled();
    const callback = parseWidgetCallback(query, body);
    const reverse = this.config.getReverseSync();
    if (callback.domain !== reverse.portalDomain) {
      throw new ApiError(403, 'BITRIX24_PORTAL_DENIED', 'Bitrix24 portal is not allowed');
    }
    const installation = await this.requireInstallation(callback);
    const current = await this.bitrix.currentUser({
      domain: callback.domain,
      accessToken: callback.accessToken,
    });
    if (!current.active) {
      throw new ApiError(403, 'BITRIX24_WIDGET_ACTOR_INACTIVE', 'Bitrix24 user is inactive');
    }
    await this.bitrix.getDeal({
      domain: callback.domain,
      accessToken: callback.accessToken,
      dealId: callback.dealId,
    });
    const mapped = await this.requireMappedUser(current.id);
    await this.requireActor(mapped, await this.repository.getDealContext(callback.dealId), false);

    const opaqueToken = randomBytes(32).toString('base64url');
    const cipher = new Bitrix24TokenCipher(settings.sessionEncryptionKey);
    await this.repository.createSession({
      tokenHash: hashWidgetToken(opaqueToken),
      memberId: installation.memberId,
      domain: installation.domain,
      dealId: callback.dealId,
      bitrixUserId: current.id,
      erpUserId: mapped.userId,
      accessTokenCiphertext: cipher.encrypt(callback.accessToken),
      refreshTokenCiphertext: cipher.encrypt(callback.refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + callback.expiresIn * 1000),
      expiresAt: new Date(Date.now() + settings.sessionTtlSeconds * 1000),
    });
    return {
      token: opaqueToken,
      dealId: callback.dealId,
      actorDisplayName: current.name,
    };
  }

  async authenticate(opaqueToken: string): Promise<AuthenticatedWidgetSession> {
    const settings = this.requireEnabled();
    const session = await this.repository.getSession(hashWidgetToken(opaqueToken));
    if (!session) throw sessionExpired();
    const installation = await this.repository.getActiveInstallation(
      session.memberId,
      session.domain,
    );
    if (!installation) throw sessionExpired();
    const mapped = await this.requireMappedUser(session.bitrixUserId);
    if (mapped.userId !== session.erpUserId) {
      await this.repository.revokeSession(session.sessionId);
      throw sessionExpired();
    }
    const authorization = await this.permissions.loadRoleAuthorization(mapped.roleId);
    const actor: CurrentUser = {
      id: String(mapped.userId),
      username: mapped.username,
      role: mapped.roleCode,
      roleId: mapped.roleId,
      permissions: authorization.permissions,
      policyScopes: authorization.scopes,
      permissionsVersion: authorization.version,
    };
    const cipher = new Bitrix24TokenCipher(settings.sessionEncryptionKey);
    const accessToken = cipher.decrypt(session.accessTokenCiphertext);
    const refreshToken = cipher.decrypt(session.refreshTokenCiphertext);
    const current = await this.bitrix.currentUser({ domain: session.domain, accessToken });
    if (!current.active || current.id !== session.bitrixUserId) {
      await this.repository.revokeSession(session.sessionId);
      throw sessionExpired();
    }
    await this.bitrix.getDeal({
      domain: session.domain,
      accessToken,
      dealId: session.dealId,
    });
    return {
      session,
      actor,
      actorDisplayName: current.name,
      accessToken,
      refreshToken,
      installation,
    };
  }

  async requireCreateAccess(
    authenticated: AuthenticatedWidgetSession,
    deal: WidgetDealContext,
  ): Promise<void> {
    const mapped: WidgetMappedUser = {
      userId: Number(authenticated.actor.id),
      username: authenticated.actor.username,
      fullName: authenticated.actorDisplayName,
      roleId: authenticated.actor.roleId,
      roleCode: authenticated.actor.role,
    };
    await this.requireActor(mapped, deal, true, authenticated.actor);
  }

  private async requireInstallation(
    callback: Bitrix24WidgetCallback,
  ): Promise<ActiveWidgetInstallation> {
    const installation = await this.repository.getActiveInstallation(
      callback.memberId,
      callback.domain,
    );
    if (
      !installation ||
      !matchesBitrix24ApplicationToken(
        callback.applicationToken,
        installation.applicationTokenHash,
      )
    ) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_AUTH_FAILED',
        'Bitrix24 widget callback authentication failed',
      );
    }
    return installation;
  }

  private async requireMappedUser(bitrixUserId: string): Promise<WidgetMappedUser> {
    const mapped = await this.repository.findMappedUser(bitrixUserId);
    if (!mapped) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_ACTOR_UNMAPPED',
        'Bitrix24 user is not mapped to an active ERP user',
      );
    }
    return mapped;
  }

  private async requireActor(
    mapped: WidgetMappedUser,
    deal: WidgetDealContext,
    requireLinked: boolean,
    loadedActor?: CurrentUser,
  ): Promise<void> {
    const authorization = loadedActor
      ? {
          permissions: loadedActor.permissions,
          scopes: loadedActor.policyScopes!,
          version: loadedActor.permissionsVersion ?? 0,
        }
      : await this.permissions.loadRoleAuthorization(mapped.roleId);
    const actor: CurrentUser = loadedActor ?? {
      id: String(mapped.userId),
      username: mapped.username,
      role: mapped.roleCode,
      roleId: mapped.roleId,
      permissions: authorization.permissions,
      policyScopes: authorization.scopes,
      permissionsVersion: authorization.version,
    };
    const required = [
      'bitrix24.payments.create',
      'payments.create',
      'orders.view_financials',
    ] as const;
    if (required.some((permission) => !actor.permissions.includes(permission))) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_PERMISSION_DENIED',
        'ERP user cannot create Bitrix24 payments',
        { requiredPermissions: required },
      );
    }
    if (requireLinked && deal.requestId === null && deal.orderId === null) {
      throw new ApiError(404, 'BITRIX24_DEAL_NOT_LINKED', 'Bitrix24 Deal is not linked to ERP');
    }
    if (deal.orderId !== null) {
      const allowed = this.paymentPolicy.canCreate(actor, {
        paymentId: 'new',
        order: {
          createdByUserId: deal.createdBy === null ? null : String(deal.createdBy),
          managerUserId: deal.managerId === null ? null : String(deal.managerId),
        },
      });
      if (!allowed) {
        throw new ApiError(
          403,
          'BITRIX24_WIDGET_PERMISSION_DENIED',
          'ERP payment scope does not allow this order',
        );
      }
    }
  }

  private requireEnabled(): ReturnType<CrmSyncRuntimeConfigService['getPaymentWidget']> & {
    sessionEncryptionKey: string;
    commandTokenEncryptionKey: string;
  } {
    const settings = this.config.getPaymentWidget();
    if (!settings.enabled || !settings.sessionEncryptionKey || !settings.commandTokenEncryptionKey) {
      throw new ApiError(
        503,
        'BITRIX24_PAYMENT_WIDGET_DISABLED',
        'Bitrix24 payment widget is disabled',
      );
    }
    return settings as typeof settings & {
      sessionEncryptionKey: string;
      commandTokenEncryptionKey: string;
    };
  }
}

function sessionExpired(): ApiError {
  return new ApiError(
    401,
    'BITRIX24_WIDGET_SESSION_EXPIRED',
    'Bitrix24 widget session expired',
  );
}
