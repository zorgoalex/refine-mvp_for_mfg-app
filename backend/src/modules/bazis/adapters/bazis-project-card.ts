import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { refineDefaultCardClients } from '../../doweling/adapters/doweling-sql';
import { assertDowelingOrdersWritable } from '../../doweling/adapters/doweling-write-guard';
import { BazisProjectCardChangedError, BazisProjectCardConflictError, BazisProjectNotFoundError } from '../errors/bazis.errors';

/**
 * The card of a Bazis XML project — the Bazis project card the user sees (a `doweling_orders` row, migration 279).
 * One resolution for every writer that needs it (order created from XML, import of a revision, design engineer,
 * reconciliation; plan v8 §0a), under the lock hierarchy
 *   group (`projects`) FOR SHARE → card(s) FOR UPDATE in id order → XML project FOR UPDATE → revision.
 * The XML project and its candidates are read without locks first, then locked in that order and read again: a change
 * in between is answered 409 BAZIS_PROJECT_CARD_CHANGED (repeat), never a second card.
 */

export interface XmlProjectCardState {
  bazisProjectId: number;
  projectId: number;
  groupClientId: number;
  /** `bazis_projects.doweling_order_id` under lock. */
  linkedCardId: number | null;
  /** Without a link: active cards linked to the orders of this XML project (`bazis_order_links`). */
  candidateCardIds: number[];
  cards: Map<number, LockedCard>;
}

export interface LockedCard {
  cardId: number;
  clientId: number;
  clientSource: string;
  deleted: boolean;
  version: number;
  name: string;
}

export type CardResolution =
  | { kind: 'linked'; card: LockedCard }
  | { kind: 'adopt'; card: LockedCard }
  | { kind: 'none' };

interface ProjectRow extends QueryResultRow {
  bazis_project_id: string | number;
  project_id: string | number;
  doweling_order_id: string | number | null;
  client_id: string | number;
}

interface CardRow extends QueryResultRow {
  doweling_order_id: string | number;
  client_id: string | number;
  client_source: string;
  delete_flag: boolean;
  version: number;
  doweling_order_name: string;
}

const CANDIDATES_SQL = `
  SELECT DISTINCT d.doweling_order_id
  FROM bazis_order_links bl
  JOIN order_doweling_links l ON l.order_id = bl.order_id AND l.delete_flag = false
  JOIN doweling_orders d ON d.doweling_order_id = l.doweling_order_id AND d.delete_flag = false
  WHERE bl.bazis_project_id = $1
  ORDER BY d.doweling_order_id`;

async function readProject(tx: DatabaseClient, bazisProjectId: number, lock: boolean): Promise<ProjectRow> {
  const result = await tx.query<ProjectRow>(
    `
    SELECT bp.bazis_project_id, bp.project_id, bp.doweling_order_id, p.client_id
    FROM bazis_projects bp
    JOIN projects p ON p.project_id = bp.project_id
    WHERE bp.bazis_project_id = $1
    ${lock ? 'FOR UPDATE OF bp' : ''}
    `,
    [bazisProjectId],
  );
  const row = result.rows[0];
  if (!row) throw new BazisProjectNotFoundError(bazisProjectId);
  return row;
}

async function readCandidates(tx: DatabaseClient, bazisProjectId: number): Promise<number[]> {
  const result = await tx.query<{ doweling_order_id: string | number }>(CANDIDATES_SQL, [bazisProjectId]);
  return result.rows.map((row) => Number(row.doweling_order_id));
}

/** Locks a card that is not tied to an XML project yet (import into a card): group → card, nothing else. */
export async function lockCard(tx: TransactionClient, cardId: number): Promise<LockedCard | null> {
  const result = await tx.query<CardRow>(
    `
    SELECT doweling_order_id, client_id, client_source, delete_flag, version, doweling_order_name
    FROM doweling_orders
    WHERE doweling_order_id = $1
    FOR UPDATE
    `,
    [cardId],
  );
  const row = result.rows[0];
  return row ? toCard(row) : null;
}

function toCard(row: CardRow): LockedCard {
  return {
    cardId: Number(row.doweling_order_id),
    clientId: Number(row.client_id),
    clientSource: row.client_source,
    deleted: row.delete_flag === true,
    version: Number(row.version),
    name: row.doweling_order_name,
  };
}

/** Locks group → card(s) → XML project in the hierarchy order and returns the state read under the locks. */
export async function lockXmlProjectWithCard(
  tx: TransactionClient,
  bazisProjectId: number,
  /** Other cards the caller writes (the card an import goes to): locked in the same id-ordered set (R1 #4). */
  extraCardIds: readonly number[] = [],
): Promise<XmlProjectCardState> {
  const preview = await readProject(tx, bazisProjectId, false);
  const previewLinked = preview.doweling_order_id === null ? null : Number(preview.doweling_order_id);
  const previewCandidates = previewLinked === null ? await readCandidates(tx, bazisProjectId) : [];

  await tx.query('SELECT project_id FROM projects WHERE project_id = $1 FOR SHARE', [preview.project_id]);
  const cardIds = [...new Set([...(previewLinked === null ? previewCandidates : [previewLinked]), ...extraCardIds])]
    .sort((a, b) => a - b);
  const cards = new Map<number, LockedCard>();
  if (cardIds.length > 0) {
    const locked = await tx.query<CardRow>(
      `
      SELECT doweling_order_id, client_id, client_source, delete_flag, version, doweling_order_name
      FROM doweling_orders
      WHERE doweling_order_id = ANY($1::bigint[])
      ORDER BY doweling_order_id
      FOR UPDATE
      `,
      [cardIds],
    );
    for (const row of locked.rows) cards.set(Number(row.doweling_order_id), toCard(row));
  }

  const project = await readProject(tx, bazisProjectId, true);
  const linkedCardId = project.doweling_order_id === null ? null : Number(project.doweling_order_id);
  const candidateCardIds = linkedCardId === null ? await readCandidates(tx, bazisProjectId) : [];
  const unchanged = linkedCardId === previewLinked
    && Number(project.project_id) === Number(preview.project_id)
    && candidateCardIds.join(',') === previewCandidates.join(',');
  if (!unchanged) {
    throw new BazisProjectCardChangedError(bazisProjectId);
  }
  return {
    bazisProjectId,
    projectId: Number(project.project_id),
    groupClientId: Number(project.client_id),
    linkedCardId,
    candidateCardIds,
    cards,
  };
}

/**
 * §0a: the existing link; else the single candidate of the XML project's client (adopt); several candidates or one of
 * another client — a conflict the user resolves; none — the caller creates a card or leaves the XML project without one.
 */
export function resolveCard(state: XmlProjectCardState): CardResolution {
  if (state.linkedCardId !== null) {
    const card = state.cards.get(state.linkedCardId);
    if (!card) throw new BazisProjectCardChangedError(state.bazisProjectId);
    return { kind: 'linked', card };
  }
  if (state.candidateCardIds.length === 0) return { kind: 'none' };
  const card = state.candidateCardIds.length === 1 ? state.cards.get(state.candidateCardIds[0]) : undefined;
  if (!card || card.clientId !== state.groupClientId) {
    throw new BazisProjectCardConflictError(state.bazisProjectId, state.candidateCardIds);
  }
  return { kind: 'adopt', card };
}

export interface CardWriteContext {
  /** Pool-backed client for the denied audit (outside the transaction). */
  database: DatabaseClient;
  tx: TransactionClient;
  currentUser: CurrentUser;
  requestId: string;
  source: string;
}

/**
 * Writing to an existing card (linking an order, attaching XML) needs `doweling.update` and update access to every
 * order already linked to the card — the rule of the doweling commands (`assertDowelingOrdersWritable`). Its orders are
 * read without locks: the card is already locked (lock hierarchy of doweling-sql.ts).
 */
export async function assertCardWritable(context: CardWriteContext, cardId: number, ownOrderId = 0): Promise<void> {
  await assertDowelingOrdersWritable({
    database: context.database,
    tx: context.tx,
    currentUser: context.currentUser,
    requestId: context.requestId,
    action: 'bazis_xml',
    dowelingOrderIds: [cardId],
    ownOrderId,
  });
}

/** A new card is created with `doweling.create` (the quick-create right). */
export function assertCardCreatable(currentUser: CurrentUser): void {
  if (!currentUser.permissions.includes('doweling.create')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для создания Базис-проекта', {
      requiredPermissions: ['doweling.create'],
    });
  }
}

/** Bumps the card version explicitly (the 256 triggers do not see the XML link) and returns the new one. */
async function bumpCardVersion(tx: TransactionClient, cardId: number): Promise<number> {
  const result = await tx.query<{ version: number }>(
    'UPDATE doweling_orders SET version = version + 1 WHERE doweling_order_id = $1 RETURNING version',
    [cardId],
  );
  return Number(result.rows[0].version);
}

async function enqueue(
  tx: TransactionClient,
  eventType: string,
  aggregateId: number,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'doweling_order', $2, $3::jsonb, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [eventType, String(aggregateId), JSON.stringify({ eventType, ...payload, idempotencyKey }), idempotencyKey],
  );
}

/**
 * Attaches the XML project to a card (adopt of the single candidate, import into a card, a card created for it):
 * `bazis.project_card_linked`, version +1, `doweling_order.updated` keyed by the new version — one event per
 * transition. Never `doweling.created` (R7 #1).
 */
export async function attachXmlToCard(
  context: CardWriteContext,
  input: { bazisProjectId: number; projectId: number; card: LockedCard; origin: string; previousCardId?: number | null },
): Promise<void> {
  await context.tx.query('UPDATE bazis_projects SET doweling_order_id = $2 WHERE bazis_project_id = $1', [
    input.bazisProjectId,
    input.card.cardId,
  ]);
  const version = await bumpCardVersion(context.tx, input.card.cardId);
  const auditId = await auditService.record(context.tx, {
    event: 'bazis.project_card_linked',
    entityType: 'bazis_project',
    entityId: String(input.bazisProjectId),
    actorUserId: context.currentUser.id,
    actorUsername: context.currentUser.username,
    actorRole: context.currentUser.role,
    requestId: context.requestId,
    source: context.source,
    relatedClientId: input.card.clientId,
    before: { dowelingOrderId: input.previousCardId ?? null },
    after: { dowelingOrderId: input.card.cardId },
    diff: { dowelingOrderId: { from: input.previousCardId ?? null, to: input.card.cardId } },
    metadata: {
      origin: input.origin,
      bazisProjectId: input.bazisProjectId,
      projectId: input.projectId,
      dowelingOrderId: input.card.cardId,
      cardVersion: version,
      requestId: context.requestId,
    },
    relatedEntities: [
      { entityType: 'bazis_project', entityId: input.bazisProjectId },
      { entityType: 'doweling_order', entityId: input.card.cardId },
      { entityType: 'project', entityId: input.projectId },
    ],
  });
  await enqueue(context.tx, 'doweling_order.updated', input.card.cardId, {
    dowelingOrderId: input.card.cardId,
    action: 'bazis_project_card_linked',
    origin: input.origin,
    bazisProjectId: input.bazisProjectId,
    version,
    auditId,
    actorUserId: context.currentUser.id,
    requestId: context.requestId,
  }, `bazis-card-xml-attached-${input.bazisProjectId}-${version}`);
}

/** Detaches a deleted XML project from its card: `bazis.project_card_unlinked`, version +1, `doweling_order.updated`. */
export async function detachXmlFromCard(
  context: CardWriteContext,
  input: { bazisProjectId: number; projectId: number; card: LockedCard },
): Promise<void> {
  await context.tx.query('UPDATE bazis_projects SET doweling_order_id = NULL WHERE bazis_project_id = $1', [
    input.bazisProjectId,
  ]);
  const version = await bumpCardVersion(context.tx, input.card.cardId);
  const auditId = await auditService.record(context.tx, {
    event: 'bazis.project_card_unlinked',
    entityType: 'bazis_project',
    entityId: String(input.bazisProjectId),
    actorUserId: context.currentUser.id,
    actorUsername: context.currentUser.username,
    actorRole: context.currentUser.role,
    requestId: context.requestId,
    source: context.source,
    relatedClientId: input.card.clientId,
    before: { dowelingOrderId: input.card.cardId },
    after: { dowelingOrderId: null },
    diff: { dowelingOrderId: { from: input.card.cardId, to: null } },
    metadata: {
      origin: 'bazis_project_delete',
      bazisProjectId: input.bazisProjectId,
      projectId: input.projectId,
      dowelingOrderId: input.card.cardId,
      cardVersion: version,
      requestId: context.requestId,
    },
    relatedEntities: [
      { entityType: 'bazis_project', entityId: input.bazisProjectId },
      { entityType: 'doweling_order', entityId: input.card.cardId },
    ],
  });
  await enqueue(context.tx, 'doweling_order.updated', input.card.cardId, {
    dowelingOrderId: input.card.cardId,
    action: 'bazis_project_card_unlinked',
    bazisProjectId: input.bazisProjectId,
    version,
    auditId,
    actorUserId: context.currentUser.id,
    requestId: context.requestId,
  }, `bazis-card-xml-detached-${input.bazisProjectId}-${version}`);
}

/**
 * Creates the card of an XML project (no card, no candidates): client = the XML group's client, «Не оплачен», the
 * design engineer of the XML project. `doweling.created` + `doweling_order.created` with the caller's key, then the
 * attach events.
 */
export async function createCardForXml(
  context: CardWriteContext,
  input: {
    bazisProjectId: number;
    projectId: number;
    groupClientId: number;
    name: string;
    designEngineerId: number;
    productionStatusId: number | null;
    partsCount: number;
    origin: 'bazis_import' | 'bazis_design_engineer' | 'bazis_create_order';
    clientSource: 'manual' | 'order';
    createdKey: string;
  },
): Promise<LockedCard> {
  const inserted = await context.tx.query<CardRow>(
    `
    INSERT INTO doweling_orders
      (doweling_order_name, doweling_order_date, payment_status_id, production_status_id, design_engineer_id,
       operator_id, parts_count, client_id, client_source)
    VALUES ($1, CURRENT_DATE,
            (SELECT payment_status_id FROM payment_statuses WHERE payment_status_code = 'unpaid'),
            $2, $3, $3, $4, $5, $6)
    RETURNING doweling_order_id, client_id, client_source, delete_flag, version, doweling_order_name
    `,
    [input.name.trim().slice(0, 200), input.productionStatusId, input.designEngineerId, input.partsCount,
      input.groupClientId, input.clientSource],
  );
  const card = toCard(inserted.rows[0]);
  const auditId = await auditService.record(context.tx, {
    event: 'doweling.created',
    entityType: 'doweling_order',
    entityId: String(card.cardId),
    actorUserId: context.currentUser.id,
    actorUsername: context.currentUser.username,
    actorRole: context.currentUser.role,
    requestId: context.requestId,
    source: context.source,
    relatedClientId: card.clientId,
    before: {},
    after: {
      dowelingOrderId: card.cardId,
      dowelingOrderName: card.name,
      clientId: card.clientId,
      designEngineerId: input.designEngineerId,
      productionStatusId: input.productionStatusId,
    },
    diff: { created: { from: false, to: true } },
    metadata: { origin: input.origin, bazisProjectId: input.bazisProjectId, action: `${input.origin}_card`, requestId: context.requestId },
    relatedEntities: [
      { entityType: 'doweling_order', entityId: card.cardId },
      { entityType: 'bazis_project', entityId: input.bazisProjectId },
      { entityType: 'employee', entityId: input.designEngineerId },
    ],
  });
  await enqueue(context.tx, 'doweling_order.created', card.cardId, {
    dowelingOrderId: card.cardId,
    dowelingOrderName: card.name,
    clientId: card.clientId,
    bazisProjectId: input.bazisProjectId,
    designEngineerId: input.designEngineerId,
    origin: input.origin,
    auditId,
    actorUserId: context.currentUser.id,
    requestId: context.requestId,
  }, input.createdKey);
  await attachXmlToCard(context, {
    bazisProjectId: input.bazisProjectId,
    projectId: input.projectId,
    card,
    origin: input.origin,
  });
  return card;
}

/**
 * Links a new order (created from the XML of this card) to the card: fields of the card stay as they are.
 * `doweling.updated` (action `bazis_order_linked`, before/after of its orders) + `doweling_order.updated`
 * keyed by order and card (one event per order created from XML).
 */
export async function linkOrderToCard(
  context: CardWriteContext,
  input: { card: LockedCard; orderId: number; bazisProjectId: number; revisionId: number },
): Promise<void> {
  if (input.card.deleted) {
    throw new ApiError(409, 'BAZIS_PROJECT_CARD_INACTIVE', 'Базис-проект неактивен: включите его или выберите другой', {
      dowelingOrderId: input.card.cardId,
      bazisProjectId: input.bazisProjectId,
    });
  }
  const before = (await context.tx.query<{ order_id: string | number }>(
    'SELECT order_id FROM order_doweling_links WHERE doweling_order_id = $1 AND delete_flag = false ORDER BY order_id',
    [input.card.cardId],
  )).rows.map((row) => Number(row.order_id));
  await context.tx.query('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [
    input.orderId,
    input.card.cardId,
  ]);
  // A card of an unknown client (written by the previous backend) takes the client of the new order.
  await refineDefaultCardClients(context.tx, [input.card.cardId], context);
  const after = [...new Set([...before, input.orderId])].sort((a, b) => a - b);
  const version = Number((await context.tx.query<{ version: number }>(
    'SELECT version FROM doweling_orders WHERE doweling_order_id = $1', [input.card.cardId])).rows[0].version);
  const auditId = await auditService.record(context.tx, {
    event: 'doweling.updated',
    entityType: 'doweling_order',
    entityId: String(input.card.cardId),
    actorUserId: context.currentUser.id,
    actorUsername: context.currentUser.username,
    actorRole: context.currentUser.role,
    requestId: context.requestId,
    source: context.source,
    relatedOrderId: input.orderId,
    relatedClientId: input.card.clientId,
    before: { orderIds: before },
    after: { orderIds: after },
    diff: { orderIds: { from: before, to: after } },
    metadata: {
      action: 'bazis_order_linked',
      dowelingOrderId: input.card.cardId,
      orderId: input.orderId,
      bazisProjectId: input.bazisProjectId,
      revisionId: input.revisionId,
      clientId: input.card.clientId,
      version,
      requestId: context.requestId,
    },
    relatedEntities: [
      { entityType: 'doweling_order', entityId: input.card.cardId },
      { entityType: 'order', entityId: input.orderId },
      { entityType: 'bazis_project', entityId: input.bazisProjectId },
    ],
  });
  await enqueue(context.tx, 'doweling_order.updated', input.card.cardId, {
    dowelingOrderId: input.card.cardId,
    action: 'bazis_order_linked',
    addedOrderIds: [input.orderId],
    orderIds: after,
    bazisProjectId: input.bazisProjectId,
    version,
    auditId,
    actorUserId: context.currentUser.id,
    requestId: context.requestId,
  }, `bazis-card-order-linked-${input.orderId}-${input.card.cardId}`);
}
