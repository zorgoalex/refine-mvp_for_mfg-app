import { ApiError } from '../../../common/errors/api-error';
import { AuditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { DeadlineDefaultScheduleRepositoryPort } from '../application/deadline-default-schedule.service';
import { buildDeadlineDefaultSchedule } from '../domain/deadline-default-schedule';
import type {
  DeadlineDefaultScheduleDto,
  ReplaceDeadlineDefaultScheduleRequestDto,
} from '../dto/deadline-default-schedule.dto';

interface ConfigRow {
  reserve_days: number | string;
  version: number | string;
  updated_at: string | Date | null;
  configured_row_count: number | string;
  active_status_count: number | string;
  active_configured_count: number | string;
  stages: Array<{
    productionStatusId: number;
    productionStatusName: string;
    productionStatusCode: string | null;
    sortOrder: number;
    durationDays: number | null;
    parallelWithPrevious: boolean;
  }>;
}

export class PgDeadlineDefaultScheduleRepository
  implements DeadlineDefaultScheduleRepositoryPort
{
  constructor(
    private readonly database: DatabaseService,
    private readonly audit = new AuditService(),
  ) {}

  async getSchedule(client: DatabaseClient = this.database): Promise<DeadlineDefaultScheduleDto> {
    return (await loadScheduleSnapshot(client)).schedule;
  }

  async replaceSchedule(input: {
    dto: ReplaceDeadlineDefaultScheduleRequestDto;
    currentUser: CurrentUser;
    requestId?: string;
  }): Promise<DeadlineDefaultScheduleDto> {
    return this.database.transaction(async (tx) => {
      await tx.query(
        'SELECT config_id FROM deadline_default_schedule_config WHERE config_id = 1 FOR UPDATE',
      );
      const beforeSnapshot = await loadScheduleSnapshot(tx);
      const before = beforeSnapshot.schedule;
      const activeIds = before.stages.map((stage) => stage.productionStatusId);
      const requestedIds = input.dto.stages.map((stage) => stage.productionStatusId);
      if (requestedIds.length > 0) {
        assertExactStageSet(activeIds, requestedIds);
      }

      const same =
        before.reserveDays === input.dto.reserveDays &&
        beforeSnapshot.configuredRowCount === input.dto.stages.length &&
        (input.dto.stages.length === 0 ||
          before.stages.every(
            (stage, index) =>
              input.dto.stages[index]?.productionStatusId === stage.productionStatusId &&
              input.dto.stages[index]?.durationDays === stage.durationDays &&
              input.dto.stages[index]?.parallelWithPrevious ===
                stage.parallelWithPrevious,
          ));
      if (same) {
        return before;
      }

      if (before.version !== input.dto.expectedVersion) {
        throw new ApiError(
          409,
          'DEADLINE_DEFAULT_SCHEDULE_VERSION_CONFLICT',
          'Настройки сроков уже изменены другим пользователем',
          { expectedVersion: input.dto.expectedVersion, actualVersion: before.version },
        );
      }

      const actorUserId = numericUserId(input.currentUser);
      await tx.query('DELETE FROM deadline_default_stage_durations');
      for (const [index, stage] of input.dto.stages.entries()) {
        await tx.query(
          `
          INSERT INTO deadline_default_stage_durations (
            production_status_id, position, duration_days,
            parallel_with_previous, updated_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            stage.productionStatusId,
            index + 1,
            stage.durationDays,
            stage.parallelWithPrevious,
            actorUserId,
          ],
        );
      }
      await tx.query(
        `
        UPDATE deadline_default_schedule_config
        SET reserve_days = $1,
            version = version + 1,
            updated_by_user_id = $2,
            updated_at = now()
        WHERE config_id = 1
        `,
        [input.dto.reserveDays, actorUserId],
      );

      const after = (await loadScheduleSnapshot(tx)).schedule;
      const changedProductionStatusIds = changedStageIds(before, after);
      const auditId = await this.audit.record(tx, {
        event: 'deadline.default_schedule.updated',
        entityType: 'deadline_default_schedule',
        entityId: 'global',
        actorUserId,
        actorUsername: input.currentUser.username,
        actorRole: input.currentUser.role,
        requestId: input.requestId ?? 'deadline-default-schedule',
        source: 'backend-deadline-default-schedule',
        before: { ...before },
        after: { ...after },
        diff: {
          reserveDays: { from: before.reserveDays, to: after.reserveDays },
          version: { from: before.version, to: after.version },
          stages: { from: before.stages, to: after.stages },
        },
        metadata: {
          reason: input.dto.reason,
          oldVersion: before.version,
          newVersion: after.version,
          oldTotalProductionDays: before.totalProductionDays,
          newTotalProductionDays: after.totalProductionDays,
          oldPlannedOrderDays: before.plannedOrderDays,
          newPlannedOrderDays: after.plannedOrderDays,
          changedProductionStatusIds,
        },
      });
      await tx.query(
        `
        INSERT INTO outbox_events (
          event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
        )
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          'deadline.default_schedule.updated',
          'deadline_default_schedule',
          'global',
          JSON.stringify({
            schedule: after,
            actorUserId,
            requestId: input.requestId ?? null,
            auditId: auditId || null,
          }),
          `deadline-default-schedule:v${after.version}`,
        ],
      );

      return after;
    });
  }
}

async function loadScheduleSnapshot(database: DatabaseClient): Promise<{
  schedule: DeadlineDefaultScheduleDto;
  configuredRowCount: number;
}> {
  const config = await database.query<ConfigRow>(
    `
    WITH counts AS (
      SELECT
        (SELECT count(*) FROM deadline_default_stage_durations) AS configured_row_count,
        (SELECT count(*) FROM production_statuses WHERE is_active = true) AS active_status_count,
        (
          SELECT count(*)
          FROM deadline_default_stage_durations durations
          JOIN production_statuses ps
            ON ps.production_status_id = durations.production_status_id
          WHERE ps.is_active = true
        ) AS active_configured_count
    )
    SELECT
      config.reserve_days,
      config.version,
      config.updated_at,
      counts.configured_row_count,
      counts.active_status_count,
      counts.active_configured_count,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'productionStatusId', ps.production_status_id,
            'productionStatusName', ps.production_status_name,
            'productionStatusCode', ps.production_status_code,
            'sortOrder', COALESCE(durations.position, ps.sort_order, 100),
            'durationDays', durations.duration_days,
            'parallelWithPrevious', COALESCE(durations.parallel_with_previous, false)
          )
          ORDER BY
            CASE WHEN durations.position IS NULL THEN 1 ELSE 0 END,
            durations.position,
            COALESCE(ps.sort_order, 100),
            ps.production_status_name,
            ps.production_status_id
        ) FILTER (WHERE ps.production_status_id IS NOT NULL),
        '[]'::jsonb
      ) AS stages
    FROM deadline_default_schedule_config config
    CROSS JOIN counts
    LEFT JOIN production_statuses ps ON ps.is_active = true
    LEFT JOIN deadline_default_stage_durations durations
      ON durations.production_status_id = ps.production_status_id
    WHERE config.config_id = 1
    GROUP BY
      config.reserve_days,
      config.version,
      config.updated_at,
      counts.configured_row_count,
      counts.active_status_count,
      counts.active_configured_count
    `,
  );
  const row = config.rows[0];
  if (!row) {
    throw new ApiError(
      500,
      'DEADLINE_DEFAULT_SCHEDULE_CONFIG_MISSING',
      'Deadline default schedule config is missing',
    );
  }

  const configuredRowCount = Number(row.configured_row_count);
  const activeStatusCount = Number(row.active_status_count);
  const activeConfiguredCount = Number(row.active_configured_count);
  return {
    configuredRowCount,
    schedule: buildDeadlineDefaultSchedule({
      reserveDays: Number(row.reserve_days),
      version: Number(row.version),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      hasStoredConfiguration:
        configuredRowCount > 0 || Number(row.reserve_days) > 0,
      catalogAligned:
        activeStatusCount > 0 &&
        configuredRowCount === activeStatusCount &&
        activeConfiguredCount === activeStatusCount,
      stages: row.stages.map((stage) => ({
        productionStatusId: Number(stage.productionStatusId),
        productionStatusName: stage.productionStatusName,
        productionStatusCode: stage.productionStatusCode,
        sortOrder: Number(stage.sortOrder),
        durationDays: stage.durationDays === null ? null : Number(stage.durationDays),
        parallelWithPrevious: stage.parallelWithPrevious,
      })),
    }),
  };
}

function assertExactStageSet(activeIds: number[], requestedIds: number[]): void {
  const active = [...activeIds].sort((left, right) => left - right);
  const requested = [...new Set(requestedIds)].sort((left, right) => left - right);
  if (
    requested.length !== requestedIds.length ||
    active.length !== requested.length ||
    active.some((id, index) => id !== requested[index])
  ) {
    throw new ApiError(
      409,
      'DEADLINE_DEFAULT_SCHEDULE_STAGES_CHANGED',
      'Список этапов производства изменился. Обновите страницу.',
      { activeProductionStatusIds: active },
    );
  }
}

function numericUserId(user: CurrentUser): number | null {
  const value = Number(user.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function changedStageIds(
  before: DeadlineDefaultScheduleDto,
  after: DeadlineDefaultScheduleDto,
): number[] {
  const beforeById = new Map(
    before.stages.map((stage, index) => [
      stage.productionStatusId,
      {
        durationDays: stage.durationDays,
        parallelWithPrevious: stage.parallelWithPrevious,
        position: index + 1,
      },
    ]),
  );
  const afterById = new Map(
    after.stages.map((stage, index) => [
      stage.productionStatusId,
      {
        durationDays: stage.durationDays,
        parallelWithPrevious: stage.parallelWithPrevious,
        position: index + 1,
      },
    ]),
  );
  return [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .filter((id) => {
      const previous = beforeById.get(id);
      const next = afterById.get(id);
      return (
        previous?.durationDays !== next?.durationDays ||
        previous?.parallelWithPrevious !== next?.parallelWithPrevious ||
        previous?.position !== next?.position
      );
    })
    .sort((left, right) => left - right);
}
