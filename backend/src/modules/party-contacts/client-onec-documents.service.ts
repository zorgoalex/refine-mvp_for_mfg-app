import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { rolePolicyForUser } from '../../permissions/policies/scope';
import { clientOrdersScope } from '../clients-read/application/client-list-facts.service';
import type { ClientOrdersScope } from '../clients-read/application/client-list-facts.types';
import { erpOrderOfOnecOrderSql } from '../payments-onec/domain/onec-order-link-sql';
import { ClientCounterpartyRepository } from './client-counterparty.repository';

/** Groups of 1C documents of a customer shown in the client card; purchase documents are never part of it. */
export const CLIENT_ONEC_DOCUMENT_GROUPS = {
  orders: ['customer_order'],
  shipments: ['sales_shipment'],
  receipts: ['cash_receipt', 'bank_receipt'],
  refunds: ['cash_refund', 'bank_refund'],
} as const;
export type ClientOnecDocumentGroup = keyof typeof CLIENT_ONEC_DOCUMENT_GROUPS;
export const CLIENT_ONEC_DOCUMENT_GROUP_NAMES = Object.keys(CLIENT_ONEC_DOCUMENT_GROUPS) as ClientOnecDocumentGroup[];
const ALL_KINDS = Object.values(CLIENT_ONEC_DOCUMENT_GROUPS).flat() as string[];
export const CLIENT_ONEC_DOCUMENTS_PAGE_SIZE_MAX = 100;

const REQUIRED = ['clients.view', 'clients.onec_documents.view', 'orders.view'] as const;

/** What a document is in 1C now; only `posted` documents take part in the totals. */
export type ClientOnecDocumentState = 'posted' | 'not_posted' | 'deleted' | 'missing';

export interface ClientOnecDocumentDto {
  id: string;
  group: ClientOnecDocumentGroup;
  kind: string;
  number: string | null;
  date: string | null;
  state: ClientOnecDocumentState;
  /** State of a customer order in 1C («В работе», «Выполнен»…); null for other documents. */
  orderStateName: string | null;
  responsibleName: string | null;
  /** ERP orders the document leads to (through the 1C customer orders it refers to), within the user's order visibility. */
  erpOrders: Array<{ orderId: number; orderName: string }>;
  /** Null when 1C gave no total for the document. */
  amount?: string | null;
  currency?: string | null;
}

/** Money of the posted documents the user may see, per currency (amounts of different currencies are never added). */
export interface ClientOnecDocumentsSummaryDto {
  currency: string | null;
  ordered: string;
  shipped: string;
  received: string;
  refunded: string;
  /** Shipped minus what is paid net of refunds: positive — the customer owes, negative — an advance. By 1C data only. */
  balance: string;
}

export interface ClientOnecDocumentsResponseDto {
  /** The client has a 1C counterparty. Without one there are no documents to show. */
  linked: boolean;
  counterparty: { refKey1c: string; name: string | null } | null;
  data: ClientOnecDocumentDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** Which documents the user is shown: all of the counterparty, or only those that lead to the user's own ERP orders. */
  scope: 'all' | 'own';
  /** Number of visible documents per group (whatever group is asked for). */
  groups: Record<ClientOnecDocumentGroup, number>;
  /** Absent without `orders.view_financials`. */
  summary?: ClientOnecDocumentsSummaryDto[];
}

type VisibleScope = Exclude<ClientOrdersScope, { kind: 'none' }>;

/** The 1C customer orders a document refers to: itself (a customer order), its header, its live lines. */
const ORDER_REFS = `(
    SELECT d.onec_ref_key AS ref WHERE d.doc_kind = 'customer_order'
    UNION
    SELECT d.onec_order_ref_key WHERE d.onec_order_ref_key IS NOT NULL
    UNION
    SELECT l.onec_order_ref_key FROM onec_document_lines l
     WHERE l.onec_document_id = d.onec_document_id AND l.removed_in_onec_at IS NULL AND l.onec_order_ref_key IS NOT NULL)`;

/**
 * A live line of the document `d` that names no 1C customer order, so whose order it pays or ships is unknown. A line of
 * a shipment follows the order of the shipment header; lines of a customer order belong to that order; the «total»
 * line of a document without a breakdown names nothing by design (such a document refers to no order at all).
 */
const UNATTRIBUTED_LINE = `(SELECT 1 FROM onec_document_lines u
     WHERE u.onec_document_id = d.onec_document_id AND u.removed_in_onec_at IS NULL AND u.line_section <> 'total'
       AND u.onec_order_ref_key IS NULL AND d.doc_kind <> 'customer_order'
       AND NOT (d.doc_kind = 'sales_shipment' AND d.onec_order_ref_key IS NOT NULL))`;

const STATE = `CASE WHEN d.missing_in_source_at IS NOT NULL THEN 'missing' WHEN d.deleted_in_onec THEN 'deleted'
                    WHEN NOT d.posted THEN 'not_posted' ELSE 'posted' END`;

const GROUP = `CASE d.doc_kind WHEN 'customer_order' THEN 'orders' WHEN 'sales_shipment' THEN 'shipments'
                               WHEN 'cash_receipt' THEN 'receipts' WHEN 'bank_receipt' THEN 'receipts' ELSE 'refunds' END`;

/**
 * «Документы 1С» of the client card: customer orders, shipments, receipts and refunds of the 1C counterparty the
 * client is linked to. Read-only; needs `clients.view`, `clients.onec_documents.view` and `orders.view`; money
 * needs `orders.view_financials`. Rights are checked here by literal membership, so a refusal is audited.
 *
 * The order visibility of the user is part of every query (rows, counts and sums use one predicate). A user
 * limited to his own orders sees a document only when it refers to at least one 1C customer order and EVERY
 * order it refers to resolves (manual link, otherwise the series rule — the resolution of the receipts read
 * model) to an ERP order of his own — creator or manager, the same rule as «Документы ERP» — and no live line of it
 * is left without an order (unknown belonging hides the whole document: its amount is shown in full or not at all).
 * A document that also pays another manager's order is therefore not shown, and
 * a refund (which refers to a receipt, not to an order) is shown only to users who see all orders.
 */
@Injectable()
export class ClientOnecDocumentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ClientCounterpartyRepository) private readonly counterparties: ClientCounterpartyRepository,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  /** Series of the 1C order numbers that are ERP orders (`BACKEND_ONEC_ORDER_NUMBER_SERIES`); null — only manual links. */
  private series(): string | null {
    return this.config.get('BACKEND_ONEC_ORDER_NUMBER_SERIES', { infer: true }) || null;
  }

  async list(
    user: CurrentUser, clientId: number, query: { group?: ClientOnecDocumentGroup; page: number; pageSize: number }, requestId: string,
  ): Promise<ClientOnecDocumentsResponseDto> {
    const scope = clientOrdersScope(user);
    const missing = REQUIRED.filter((permission) => !user.permissions.includes(permission));
    if (missing.length > 0 || scope.kind === 'none') {
      await auditService.recordDenied(this.database, {
        event: 'clients.onec_documents_denied', entityType: 'client', entityId: clientId, relatedClientId: clientId,
        actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId,
        source: 'backend-party-contacts', reason: missing.length > 0 ? 'missing_permission' : 'scope_not_allowed',
        requiredPermissions: [...REQUIRED],
        metadata: { action: 'client_onec_documents', missingPermissions: missing, orderScope: rolePolicyForUser(user).orders.view },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра документов 1С клиента', { requiredPermissions: [...REQUIRED] });
    }
    // The link and the name of the counterparty — as the card shows them to a reader without `clients.onec_data.view`
    // (no phones, no BIN/IIN); a missing client is 404 there.
    const link = await this.counterparties.link(clientId, this.database, false);
    const client = { ref_key_1c: link.refKey1c };
    const { page, pageSize } = query;
    const empty = { data: [], pagination: { page, pageSize, total: 0, totalPages: 1 }, scope: scope.kind, groups: { orders: 0, shipments: 0, receipts: 0, refunds: 0 } };
    const financials = user.permissions.includes('orders.view_financials');
    if (client.ref_key_1c === null) return { linked: false, counterparty: null, ...empty, ...(financials ? { summary: [] } : {}) };

    const params: unknown[] = [client.ref_key_1c, ALL_KINDS];
    // The ERP order of the 1C order `r.ref` of the document `d`; the series is a parameter only of the queries that use it.
    const erpOrder = (series: string) => erpOrderOfOnecOrderSql('d.source_id', 'r.ref', series);
    const ownSeries = scope.kind === 'own' ? `$${params.push(this.series())}` : null;
    const own = scope.kind === 'own' && ownSeries ? this.ownOrderSql(params, scope, erpOrder(ownSeries)) : null;
    // One predicate for rows, counts and sums.
    const visible = `d.counterparty_ref_key = $1::uuid AND d.doc_kind = ANY($2::text[])${own === null ? '' : `
      AND EXISTS (SELECT 1 FROM ${ORDER_REFS} r)
      AND NOT EXISTS ${UNATTRIBUTED_LINE}
      AND NOT EXISTS (SELECT 1 FROM ${ORDER_REFS} r WHERE NOT EXISTS (${own}))`}`;

    const totals = await this.database.query<{ grp: ClientOnecDocumentGroup; currency: string | null; n: string; live_amount: string }>(
      `SELECT ${GROUP} AS grp, d.currency, count(*)::text AS n,
              COALESCE(sum(d.amount) FILTER (WHERE ${STATE} = 'posted'), 0.00)::text AS live_amount
         FROM onec_documents d WHERE ${visible} GROUP BY 1, 2`, params);
    const groups = { orders: 0, shipments: 0, receipts: 0, refunds: 0 };
    for (const row of totals.rows) groups[row.grp] += Number(row.n);
    const total = query.group ? groups[query.group] : groups.orders + groups.shipments + groups.receipts + groups.refunds;

    const listParams = [...params];
    const listSeries = ownSeries ?? `$${listParams.push(this.series())}`;
    const groupFilter = query.group ? ` AND d.doc_kind = ANY($${listParams.push([...CLIENT_ONEC_DOCUMENT_GROUPS[query.group]])}::text[])` : '';
    // ERP orders of the document: through its 1C orders, never beyond the order visibility of the user.
    const erpOwn = scope.kind === 'own' ? ` AND (o.created_by = $${listParams.push(scope.userId)} OR o.manager_id = $${listParams.length})` : '';
    const rows = (await this.database.query<{
      id: string; grp: ClientOnecDocumentGroup; doc_kind: string; number: string | null; doc_date: string | null; state: ClientOnecDocumentState;
      state_name: string | null; responsible_name: string | null; amount: string | null; currency: string | null;
      erp_orders: Array<{ orderId: number; orderName: string }> | null;
    }>(
      `SELECT d.onec_document_id::text AS id, ${GROUP} AS grp, d.doc_kind, d.number, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date,
              ${STATE} AS state, co.state_name, d.responsible_name, d.amount::text AS amount, d.currency,
              (SELECT json_agg(json_build_object('orderId', x.order_id, 'orderName', x.order_name) ORDER BY x.order_id)
                 FROM (SELECT DISTINCT o.order_id, o.order_name::text AS order_name
                         FROM ${ORDER_REFS} r
                         JOIN orders o ON o.order_id = ${erpOrder(listSeries)} AND o.delete_flag = false${erpOwn}) x) AS erp_orders
         FROM onec_documents d LEFT JOIN onec_customer_orders co ON co.onec_document_id = d.onec_document_id
        WHERE ${visible}${groupFilter}
        ORDER BY d.doc_date DESC NULLS LAST, d.onec_document_id DESC
        LIMIT $${listParams.push(pageSize)} OFFSET $${listParams.push((page - 1) * pageSize)}`, listParams)).rows;

    return {
      linked: true,
      counterparty: { refKey1c: client.ref_key_1c, name: link.counterparty?.name ?? null },
      data: rows.map((row) => ({
        id: row.id, group: row.grp, kind: row.doc_kind, number: row.number, date: row.doc_date, state: row.state,
        orderStateName: row.state_name, responsibleName: row.responsible_name, erpOrders: row.erp_orders ?? [],
        // Without the right the money is absent, not zero.
        ...(financials ? { amount: row.amount, currency: row.currency } : {}),
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      scope: scope.kind,
      groups,
      ...(financials ? { summary: summarize(totals.rows) } : {}),
    };
  }

  /** «The 1C order `r.ref` of the document `d` is an ERP order of the user's own» — pushes the user id. */
  private ownOrderSql(params: unknown[], scope: Extract<VisibleScope, { kind: 'own' }>, erpOrder: string): string {
    const user = `$${params.push(scope.userId)}`;
    return `SELECT 1 FROM orders o
             WHERE o.order_id = ${erpOrder} AND o.delete_flag = false AND (o.created_by = ${user} OR o.manager_id = ${user})`;
  }
}

/** Exact decimal arithmetic on amounts with two digits after the point (as 1C stores them). */
const cents = (value: string): bigint => {
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const amount = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return value.startsWith('-') ? -amount : amount;
};
const money = (value: bigint): string => {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

export function summarize(rows: ReadonlyArray<{ grp: ClientOnecDocumentGroup; currency: string | null; live_amount: string }>): ClientOnecDocumentsSummaryDto[] {
  const byCurrency = new Map<string | null, Record<ClientOnecDocumentGroup, bigint>>();
  for (const row of rows) {
    const sums = byCurrency.get(row.currency) ?? { orders: 0n, shipments: 0n, receipts: 0n, refunds: 0n };
    sums[row.grp] += cents(row.live_amount);
    byCurrency.set(row.currency, sums);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => String(a ?? '').localeCompare(String(b ?? '')))
    .map(([currency, sums]) => ({
      currency, ordered: money(sums.orders), shipped: money(sums.shipments), received: money(sums.receipts), refunded: money(sums.refunds),
      balance: money(sums.shipments - sums.receipts + sums.refunds),
    }));
}
