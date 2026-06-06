import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectEntityLinksRepositoryPort } from '../entity-links/project-entity-links.repository';
import { PROJECT_ENTITY_REGISTRY } from '../entity-links/project-entity-registry';
import type {
  ProjectBatchLinkRequestDto,
  ProjectBatchLinkResponseDto,
} from './project-batch-link.dto';

export interface DryRunProjectBatchLinkCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ProjectBatchLinkRequestDto;
  requestId?: string;
}

export interface ProjectBatchLinkRepositoryPort {
  dryRun(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto>;
}

export interface ProjectBatchLinkPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface ProjectBatchLinkServicePorts {
  batchLinks: ProjectBatchLinkRepositoryPort;
  entityLinks?: ProjectEntityLinksRepositoryPort;
  permissions?: ProjectBatchLinkPermissionsPort;
}

const ALLOWED_BATCH_LINK_ROLES = new Set<UserRole>(['admin', 'top_manager']);

export class ProjectBatchLinkService {
  private readonly permissions: ProjectBatchLinkPermissionsPort;

  constructor(private readonly ports: ProjectBatchLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async dryRun(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto> {
    this.authorize(command);
    return this.ports.batchLinks.dryRun(command);
  }

  async write(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto> {
    this.authorize(command);
    if (!this.ports.entityLinks?.appendIdempotent) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects batch link write adapter is not configured', {
        feature: 'projects',
        writeEnabled: false,
      });
    }

    const response = await this.ports.entityLinks.appendIdempotent({
      currentUser: command.currentUser,
      projectId: command.projectId,
      requestId: command.requestId,
      source: 'projects-batch-link',
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
      projectId: command.projectId,
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
        projectId: command.projectId,
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

  private authorize(command: DryRunProjectBatchLinkCommand): void {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    if (!ALLOWED_BATCH_LINK_ROLES.has(command.currentUser.role)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        allowedRoles: [...ALLOWED_BATCH_LINK_ROLES],
      });
    }

    this.requirePermission(
      command.currentUser,
      PROJECT_ENTITY_REGISTRY[command.dto.entityType].requiredPermission as PermissionName,
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
