import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  BazisPanelOrderLink,
  ReconcileBazisPanelOrderLinksInput,
} from '../application/order-transaction.types';

const SOURCE = 'backend-bazis-panel-link-reconciler';

interface ReconciledRow {
  node_id: string | number;
  order_detail_id: string | number | null;
  bazis_project_id: string | number;
  revision_id: string | number;
  project_link_created: boolean;
}

interface SchemaGuardRow {
  reconcile_function_present: boolean;
  provenance_columns_present: boolean;
  imported_constraint_present: boolean;
}

export async function assertBazisPanelOrderLinkSchema(database: DatabaseService): Promise<void> {
  const result = await database.query<SchemaGuardRow>(
    `
    SELECT
      to_regprocedure(
        'public.reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)'
      ) IS NOT NULL AS reconcile_function_present,
      (
        SELECT count(*) = 3
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bazis_node_order_detail_map'
          AND column_name IN ('import_source', 'imported_by', 'request_id')
      ) AS provenance_columns_present,
      EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND table_row.relname = 'bazis_node_order_detail_map'
          AND constraint_row.conname = 'bazis_node_order_detail_map_mapping_kind_check'
          AND pg_get_constraintdef(constraint_row.oid) LIKE '%imported%'
      ) AS imported_constraint_present
    `,
  );
  const row = result.rows[0];
  if (
    !row?.reconcile_function_present ||
    !row.provenance_columns_present ||
    !row.imported_constraint_present
  ) {
    throw new Error('Migration 104 is required before enabling order writes');
  }
}

export async function reconcileBazisPanelOrderLinks(
  tx: TransactionClient,
  input: ReconcileBazisPanelOrderLinksInput,
): Promise<BazisPanelOrderLink[]> {
  if (input.candidateDetailIds.length === 0) return [];

  const actorId = numericUserId(input.currentUser);
  const result = await tx.query<ReconciledRow>(
    `
    SELECT node_id, order_detail_id, bazis_project_id, revision_id, project_link_created
    FROM reconcile_bazis_panel_order_links($1, $2::bigint[], $3, $4, $5)
    `,
    [
      input.orderId,
      input.candidateDetailIds,
      input.source,
      actorId,
      input.requestId,
    ],
  );
  const links = result.rows.map((row) => ({
    nodeId: Number(row.node_id),
    orderDetailId: row.order_detail_id === null ? null : Number(row.order_detail_id),
    bazisProjectId: Number(row.bazis_project_id),
    revisionId: Number(row.revision_id),
    projectLinkCreated: row.project_link_created === true,
  }));
  if (links.length === 0) return links;

  const relatedEntities = uniqueRelatedEntities(links);
  await auditService.record(tx, {
    event: 'bazis.panel_order_links_reconciled',
    entityType: 'order',
    entityId: input.orderId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedOrderId: input.orderId,
    before: {},
    after: { links },
    diff: { links: { before: [], after: links } },
    metadata: {
      source: input.source,
      requestId: input.requestId,
      candidateDetailIds: input.candidateDetailIds,
    },
    relatedEntities,
  });

  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, 'order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      'bazis.panel_order_links_reconciled',
      String(input.orderId),
      JSON.stringify({
        eventType: 'bazis.panel_order_links_reconciled',
        orderId: input.orderId,
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
        source: input.source,
        links,
      }),
      input.idempotencyKey,
    ],
  );

  return links;
}

function numericUserId(user: CurrentUser): number | null {
  const parsed = Number(user.id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueRelatedEntities(links: BazisPanelOrderLink[]) {
  const entries = new Map<string, { entityType: string; entityId: number }>();
  const add = (entityType: string, entityId: number) => {
    entries.set(`${entityType}:${entityId}`, { entityType, entityId });
  };
  for (const link of links) {
    add('bazis_node', link.nodeId);
    add('bazis_project', link.bazisProjectId);
    add('bazis_revision', link.revisionId);
    if (link.orderDetailId !== null) add('order_detail', link.orderDetailId);
  }
  return [...entries.values()];
}
