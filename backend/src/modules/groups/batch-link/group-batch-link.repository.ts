import type { QueryResultRow } from 'pg';

import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import {
  buildGroupEntityExistenceQuery,
} from '../entity-links/group-entity-registry';
import type {
  GroupBatchLinkProposalDto,
  GroupBatchLinkResponseDto,
  GroupBatchLinkSampleEvidenceDto,
  GroupBatchLinkSkippedDto,
} from './group-batch-link.dto';
import type {
  DryRunGroupBatchLinkCommand,
  GroupBatchLinkRepositoryPort,
} from './group-batch-link.service';

interface GroupRow extends QueryResultRow {
  id: string;
}

interface EntityGroupionRow extends QueryResultRow {
  entity_id: string;
  display_label: string | null;
}

export class PgGroupBatchLinkRepository implements GroupBatchLinkRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async dryRun(command: DryRunGroupBatchLinkCommand): Promise<GroupBatchLinkResponseDto> {
    await ensureGroupExists(this.database, command.groupId);

    const proposals: GroupBatchLinkProposalDto[] = [];
    const skipped: GroupBatchLinkSkippedDto[] = [];
    const sampleEvidence: GroupBatchLinkSampleEvidenceDto[] = [];

    for (const [index, item] of command.dto.items.entries()) {
      const sourceRow = item.sourceRow ?? `${command.dto.source.reference}:row-${index + 1}`;
      const query = buildReadOnlyGroupEntityExistenceQuery(command.dto.entityType, item.entityId);
      const result = await this.database.query<EntityGroupionRow>(query.text, query.values);
      const entity = result.rows[0];

      if (!entity) {
        skipped.push({
          entityType: command.dto.entityType,
          entityId: item.entityId,
          source: command.dto.source.type,
          sourceRow,
          confidence: item.confidence,
          reasonCode: 'entity_not_found',
          reasonText: 'Entity id could not be validated as an existing Groups-allowed entity.',
          evidence: {
            groupId: command.groupId,
            idempotencyKey: command.dto.idempotencyKey,
            requestId: command.requestId ?? null,
            fixtureKey: command.dto.fixtureKey,
            actorUserId: command.currentUser.id,
          },
        });
        sampleEvidence.push({
          groupId: command.groupId,
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
        groupId: command.groupId,
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
      groupId: command.groupId,
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

function buildReadOnlyGroupEntityExistenceQuery(
  entityType: DryRunGroupBatchLinkCommand['dto']['entityType'],
  entityId: string,
) {
  const query = buildGroupEntityExistenceQuery(entityType, entityId);
  return {
    ...query,
    text: query.text.replace(/\s+FOR KEY SHARE\s*$/i, ''),
  };
}

function evidenceContext(command: DryRunGroupBatchLinkCommand) {
  return {
    fixtureKey: command.dto.fixtureKey,
    idempotencyKey: command.dto.idempotencyKey,
    requestId: command.requestId ?? null,
    actorUserId: command.currentUser.id,
    actorUsername: command.currentUser.username,
  };
}

export class UnavailableGroupBatchLinkRepository implements GroupBatchLinkRepositoryPort {
  async dryRun(): Promise<GroupBatchLinkResponseDto> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups batch link adapter is not configured', {
      feature: 'groups',
    });
  }
}

async function ensureGroupExists(database: DatabaseClient, groupId: string): Promise<void> {
  const result = await database.query<GroupRow>(
    'SELECT id::text FROM public.group_groups WHERE id = $1::uuid',
    [groupId],
  );
  if (!result.rows[0]) {
    throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found', { groupId });
  }
}
