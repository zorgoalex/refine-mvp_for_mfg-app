import type { QueryResultRow } from 'pg';

import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import {
  buildProjectEntityExistenceQuery,
} from '../entity-links/project-entity-registry';
import type {
  ProjectBatchLinkProposalDto,
  ProjectBatchLinkResponseDto,
  ProjectBatchLinkSampleEvidenceDto,
  ProjectBatchLinkSkippedDto,
} from './project-batch-link.dto';
import type {
  DryRunProjectBatchLinkCommand,
  ProjectBatchLinkRepositoryPort,
} from './project-batch-link.service';

interface ProjectRow extends QueryResultRow {
  id: string;
}

interface EntityProjectionRow extends QueryResultRow {
  entity_id: string;
  display_label: string | null;
}

export class PgProjectBatchLinkRepository implements ProjectBatchLinkRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async dryRun(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto> {
    await ensureProjectExists(this.database, command.projectId);

    const proposals: ProjectBatchLinkProposalDto[] = [];
    const skipped: ProjectBatchLinkSkippedDto[] = [];
    const sampleEvidence: ProjectBatchLinkSampleEvidenceDto[] = [];

    for (const [index, item] of command.dto.items.entries()) {
      const sourceRow = item.sourceRow ?? `${command.dto.source.reference}:row-${index + 1}`;
      const query = buildReadOnlyProjectEntityExistenceQuery(command.dto.entityType, item.entityId);
      const result = await this.database.query<EntityProjectionRow>(query.text, query.values);
      const entity = result.rows[0];

      if (!entity) {
        skipped.push({
          entityType: command.dto.entityType,
          entityId: item.entityId,
          source: command.dto.source.type,
          sourceRow,
          confidence: item.confidence,
          reasonCode: 'entity_not_found',
          reasonText: 'Entity id could not be validated as an existing Projects-allowed entity.',
          evidence: {
            projectId: command.projectId,
            idempotencyKey: command.dto.idempotencyKey,
            requestId: command.requestId ?? null,
            fixtureKey: command.dto.fixtureKey,
            actorUserId: command.currentUser.id,
          },
        });
        sampleEvidence.push({
          projectId: command.projectId,
          entityType: command.dto.entityType,
          entityId: item.entityId,
          source: command.dto.source.type,
          sourceRow,
          reason: item.reason,
          skipReason: 'entity_not_found',
          ...evidenceContext(command),
        });
        continue;
      }

      proposals.push({
        entityType: command.dto.entityType,
        entityId: entity.entity_id,
        action: 'link',
        source: command.dto.source.type,
        confidence: item.confidence,
        reason: item.reason,
      });
      sampleEvidence.push({
        projectId: command.projectId,
        entityType: command.dto.entityType,
        entityId: entity.entity_id,
        source: command.dto.source.type,
        sourceRow,
        reason: item.reason,
        skipReason: null,
        ...evidenceContext(command),
      });
    }

    return {
      projectId: command.projectId,
      mode: 'dry-run',
      summary: {
        proposed: proposals.length,
        skipped: skipped.length,
        conflicts: 0,
        sampledEvidenceRows: sampleEvidence.length,
      },
      proposals,
      skipped,
      sampleEvidence,
      writeEnabled: false,
    };
  }
}

function buildReadOnlyProjectEntityExistenceQuery(
  entityType: DryRunProjectBatchLinkCommand['dto']['entityType'],
  entityId: string,
) {
  const query = buildProjectEntityExistenceQuery(entityType, entityId);
  return {
    ...query,
    text: query.text.replace(/\s+FOR KEY SHARE\s*$/i, ''),
  };
}

function evidenceContext(command: DryRunProjectBatchLinkCommand) {
  return {
    fixtureKey: command.dto.fixtureKey,
    idempotencyKey: command.dto.idempotencyKey,
    requestId: command.requestId ?? null,
    actorUserId: command.currentUser.id,
    actorUsername: command.currentUser.username,
  };
}

export class UnavailableProjectBatchLinkRepository implements ProjectBatchLinkRepositoryPort {
  async dryRun(): Promise<ProjectBatchLinkResponseDto> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects batch link adapter is not configured', {
      feature: 'projects',
    });
  }
}

async function ensureProjectExists(database: DatabaseClient, projectId: string): Promise<void> {
  const result = await database.query<ProjectRow>(
    'SELECT id::text FROM public.project_projects WHERE id = $1::uuid',
    [projectId],
  );
  if (!result.rows[0]) {
    throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found', { projectId });
  }
}
