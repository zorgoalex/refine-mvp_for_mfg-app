import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type {
  ListProjectsQuery,
  MergeCommand,
  MergeResult,
  MoveOrderCommand,
  MoveOrderResult,
  ProjectCard,
  ProjectDto,
  ProjectOrderRow,
  ProjectsRepositoryPort,
  UpdateProjectCommand,
} from '../application/projects.types';
import {
  ProjectArchivedError,
  ProjectCodeTakenError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from '../errors/projects.errors';

const SOURCE = 'backend-projects-command';

interface ProjectRow extends QueryResultRow {
  project_id: number | string;
  code: string;
  name: string;
  client_id: number | string;
  client_name?: string | null;
  notes: string | null;
  version: number | string;
  orders_count?: number | string | null;
  total_final_amount?: string | null;
  total_paid_amount?: string | null;
  delete_flag?: boolean;
}

interface ProjectOrderRowDb extends QueryResultRow {
  order_id: number | string;
  order_name: string;
  order_full_number: string;
  final_amount: string | null;
  paid_amount: string | null;
  order_status_name: string | null;
  delete_flag: boolean;
}

export class PgProjectsRepository implements ProjectsRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(query: ListProjectsQuery): Promise<ProjectDto[]> {
    const result = await this.database.query<ProjectRow>(
      `
      SELECT
        project_id,
        code,
        name,
        client_id,
        client_name,
        notes,
        version,
        orders_count,
        total_final_amount,
        total_paid_amount
      FROM projects_view
      WHERE ($1::text IS NULL OR code ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%' OR client_name ILIKE '%' || $1 || '%')
        AND ($2::bigint IS NULL OR client_id = $2)
        AND ($3::boolean = true OR delete_flag = false)
      ORDER BY delete_flag ASC, code ASC, project_id ASC
      `,
      [query.search ?? null, query.clientId ?? null, query.includeArchived ?? false],
    );

    return result.rows.map(mapProjectRow);
  }

  async getById(projectId: number): Promise<ProjectCard> {
    const project = await this.database.query<ProjectRow>(
      `
      SELECT
        project_id,
        code,
        name,
        client_id,
        client_name,
        notes,
        version,
        orders_count,
        total_final_amount,
        total_paid_amount
      FROM projects_view
      WHERE project_id = $1
      `,
      [projectId],
    );
    const row = project.rows[0];
    if (!row) {
      throw new ProjectNotFoundError(projectId);
    }

    const orders = await this.database.query<ProjectOrderRowDb>(
      `
      SELECT
        order_id,
        order_name,
        order_full_number,
        final_amount,
        paid_amount,
        order_status_name,
        delete_flag
      FROM orders_view
      WHERE project_id = $1
      ORDER BY order_id ASC
      `,
      [projectId],
    );

    return {
      ...mapProjectRow(row),
      orders: orders.rows.map(mapProjectOrderRow),
    };
  }

  async update(command: UpdateProjectCommand): Promise<ProjectDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const existing = await tx.query<ProjectRow>(
        `
        SELECT project_id, code, name, client_id, notes, version, delete_flag
        FROM projects
        WHERE project_id = $1
        FOR UPDATE
        `,
        [command.projectId],
      );
      const before = existing.rows[0];
      if (!before) {
        throw new ProjectNotFoundError(command.projectId);
      }
      if (before.delete_flag) {
        throw new ProjectArchivedError(command.projectId);
      }
      if (Number(before.version) !== command.expectedVersion) {
        throw new ProjectVersionConflictError();
      }

      try {
        const updated = await tx.query<ProjectRow>(
          `
          UPDATE projects
          SET
            code = COALESCE($2, code),
            name = COALESCE($3, name),
            notes = CASE WHEN $4::boolean THEN $5 ELSE notes END,
            version = version + 1,
            edited_by = $6,
            updated_at = now()
          WHERE project_id = $1
          RETURNING project_id, code, name, client_id, notes, version
          `,
          [
            command.projectId,
            command.dto.code ?? null,
            command.dto.name ?? null,
            command.dto.notes !== undefined,
            command.dto.notes ?? null,
            command.currentUser.id,
          ],
        );

        const row = updated.rows[0];
        await writeAudit(tx, {
          currentUser: command.currentUser,
          requestId: requestIdOrFallback(command.requestId),
          projectId: command.projectId,
          clientId: Number(before.client_id),
          before: {
            code: before.code,
            name: before.name,
            notes: before.notes,
          },
          after: {
            code: row.code,
            name: row.name,
            notes: row.notes,
          },
        });

        return mapProjectRow(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ProjectCodeTakenError(command.dto.code ?? '');
        }
        throw error;
      }
    });
  }

  moveOrder(_command: MoveOrderCommand): Promise<MoveOrderResult> {
    throw new Error('NOT_IMPLEMENTED');
  }

  merge(_command: MergeCommand): Promise<MergeResult> {
    throw new Error('NOT_IMPLEMENTED');
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    currentUser: UpdateProjectCommand['currentUser'];
    requestId: string;
    projectId: number;
    clientId: number;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: 'project.updated',
    entityType: 'project',
    entityId: String(input.projectId),
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: input.before,
    after: input.after,
    metadata: {
      projectId: input.projectId,
      action: 'project_update',
    },
    relatedEntities: [
      { entityType: 'project', entityId: input.projectId },
      { entityType: 'client', entityId: input.clientId },
    ],
  });
}

function requestIdOrFallback(requestId: string | undefined): string {
  return requestId && requestId.length > 0 ? requestId : 'projects-command';
}

function mapProjectRow(row: ProjectRow): ProjectDto {
  return {
    projectId: Number(row.project_id),
    code: row.code,
    name: row.name,
    clientId: Number(row.client_id),
    clientName: row.client_name ?? undefined,
    notes: row.notes ?? null,
    version: Number(row.version),
    ordersCount: row.orders_count === undefined || row.orders_count === null ? undefined : Number(row.orders_count),
    totalFinalAmount: row.total_final_amount ?? undefined,
    totalPaidAmount: row.total_paid_amount ?? undefined,
  };
}

function mapProjectOrderRow(row: ProjectOrderRowDb): ProjectOrderRow {
  return {
    orderId: Number(row.order_id),
    orderName: row.order_name,
    fullNumber: row.order_full_number,
    finalAmount: row.final_amount ?? null,
    paidAmount: row.paid_amount ?? null,
    orderStatusName: row.order_status_name ?? null,
    deleteFlag: row.delete_flag,
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505');
}
