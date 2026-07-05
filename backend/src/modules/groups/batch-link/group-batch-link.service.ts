import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { GroupEntityLinksRepositoryPort } from '../entity-links/group-entity-links.repository';
import { GROUP_ENTITY_REGISTRY } from '../entity-links/group-entity-registry';
import type {
  GroupBatchLinkRequestDto,
  GroupBatchLinkResponseDto,
} from './group-batch-link.dto';
import { buildBatchLinkRoleDeniedEvent } from './group-batch-link-audit';

export interface DryRunGroupBatchLinkCommand {
  currentUser: CurrentUser;
  groupId: string;
  dto: GroupBatchLinkRequestDto;
  requestId?: string;
}

export interface GroupBatchLinkRepositoryPort {
  dryRun(command: DryRunGroupBatchLinkCommand): Promise<GroupBatchLinkResponseDto>;
}

export interface GroupBatchLinkPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface GroupBatchLinkServicePorts {
  batchLinks: GroupBatchLinkRepositoryPort;
  entityLinks?: GroupEntityLinksRepositoryPort;
  permissions?: GroupBatchLinkPermissionsPort;
  database: DatabaseService;
}

const ALLOWED_BATCH_LINK_ROLES = new Set<UserRole>(['admin', 'top_manager']);

export class GroupBatchLinkService {
  private readonly permissions: GroupBatchLinkPermissionsPort;

  constructor(private readonly ports: GroupBatchLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async dryRun(command: DryRunGroupBatchLinkCommand): Promise<GroupBatchLinkResponseDto> {
    await this.authorize(command);
    return this.ports.batchLinks.dryRun(command);
  }

  async write(command: DryRunGroupBatchLinkCommand): Promise<GroupBatchLinkResponseDto> {
    await this.authorize(command);
    if (!this.ports.entityLinks?.appendIdempotent) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups batch link write adapter is not configured', {
        feature: 'groups',
        writeEnabled: false,
      });
    }

    const response = await this.ports.entityLinks.appendIdempotent({
      currentUser: command.currentUser,
      groupId: command.groupId,
      requestId: command.requestId,
      source: 'groups-batch-link',
      dto: {
        idempotencyKey: command.dto.idempotencyKey,
        reason: `batch-link:${command.dto.source.type}:${command.dto.source.reference}`,
        links: command.dto.items.map((item) => ({
          entityType: command.dto.entityType,
          entityId: item.entityId,
          relationType: command.dto.relationType,
          metadata: {
            fixtureKey: command.dto.fixtureKey,
            batchSourceType: command.dto.source.type,
            batchSourceReference: command.dto.source.reference,
            sourceRow: item.sourceRow ?? null,
            confidence: item.confidence,
            reason: item.reason,
          },
        })),
      },
    });

    const created = (response.createdLinks ?? []).map((link) => ({
      entityType: link.entityType,
      entityId: link.entityId,
      action: 'link' as const,
      source: command.dto.source.type,
      confidence: 'written',
      reason: command.dto.items.find((item) => item.entityId === link.entityId)?.reason ?? 'explicit selected id',
    }));
    const existing = (response.existingLinks ?? []).map((link) => ({
      entityType: link.entityType,
      entityId: link.entityId,
      action: 'link' as const,
      source: command.dto.source.type,
      confidence: 'existing',
      reason: command.dto.items.find((item) => item.entityId === link.entityId)?.reason ?? 'already linked',
    }));

    return {
      groupId: command.groupId,
      mode: 'write',
      summary: {
        proposed: command.dto.items.length,
        created: created.length,
        existing: existing.length,
        skipped: 0,
        conflicts: 0,
        sampledEvidenceRows: command.dto.items.length,
      },
      proposals: [],
      created,
      existing,
      skipped: [],
      sampleEvidence: command.dto.items.map((item, index) => ({
        groupId: command.groupId,
        entityType: command.dto.entityType,
        entityId: item.entityId,
        source: command.dto.source.type,
        sourceRow: item.sourceRow ?? `${command.dto.source.reference}:row-${index + 1}`,
        reason: item.reason,
        skipReason: null,
        fixtureKey: command.dto.fixtureKey,
        idempotencyKey: command.dto.idempotencyKey,
        requestId: command.requestId ?? null,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
      })),
      changed: response.changed ?? false,
      auditId: response.auditId ?? null,
      outboxEventId: response.outboxEventId ?? null,
      requestId: response.requestId,
      writeEnabled: true,
    };
  }

  private async authorize(command: DryRunGroupBatchLinkCommand): Promise<void> {
    this.requirePermission(command.currentUser, 'groups.manage_links'); // plain static → deferred (service-helper or decorate+guard)
    if (!ALLOWED_BATCH_LINK_ROLES.has(command.currentUser.role)) {
      try {
        await auditService.recordDenied(this.ports.database, buildBatchLinkRoleDeniedEvent({
          currentUser: command.currentUser,
          requestId: command.requestId ?? 'groups-command', // reuse existing groups fallback (group.repository.ts:758)
          groupId: command.groupId ?? null,
          allowedRoles: [...ALLOWED_BATCH_LINK_ROLES],
        }));
      } catch { /* best-effort */ }
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        allowedRoles: [...ALLOWED_BATCH_LINK_ROLES],
      });
    }

    this.requirePermission(
      command.currentUser,
      GROUP_ENTITY_REGISTRY[command.dto.entityType].requiredPermission,
    );
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
