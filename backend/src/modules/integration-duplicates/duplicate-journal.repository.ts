import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { appendOrderReadVisibilitySql } from '../../permissions/policies/order-read-scope-sql';
import { DuplicateEngineRepository } from './duplicate-engine.repository';
import { RULES_BY_CODE, linkSourceSql } from './duplicate-rules';
import { recordTransition, type MemberRef } from './duplicate-transitions';
import {
  type DuplicateReason, DUPLICATE_ENTITY_KINDS, ENTITY_KIND_LABELS, KIND_VIEW_PERMISSION, ONEC_VALUES_PERMISSION,
  type DuplicateEntityKind, type DuplicateStatus, type DuplicateSystem,
} from './integration-duplicates';

export interface DuplicateListQuery {
  status: DuplicateStatus | 'all';
  entityKind: DuplicateEntityKind | null;
  ruleCode: string | null;
  system: DuplicateSystem | null;
  from: Date | null;
  to: Date | null;
  search: string | null;
  page: number;
  pageSize: number;
}

export interface DuplicateMemberView {
  system: DuplicateSystem;
  entityKind: DuplicateEntityKind;
  recordKey: string;
  erpEntityId: number | null;
  /** null — the reader may not see the name (or the 1C data it comes from is not current). */
  name: string | null;
  joinedAt: string;
  leftAt: string | null;
  recordCreatedAt: string | null;
  author: { userId: number; username: string | null } | null;
  authorExternal: string | null;
  via: string;
}

export interface DuplicateCaseView {
  caseId: number;
  ruleCode: string;
  ruleLabel: string;
  entityKind: DuplicateEntityKind;
  entityKindLabel: string;
  strength: 'exact' | 'likely';
  status: DuplicateStatus;
  /** null — the key was read from 1C data that is not current now (refreshed, revoked or expired). */
  keyMask: string | null;
  sourcesState: 'none' | 'current' | 'refreshing' | 'unavailable';
  firstDetectedAt: string;
  lastSeenAt: string;
  detectedVia: string;
  resolvedAt: string | null;
  resolvedBy: { userId: number; username: string | null } | null;
  resolutionCode: string | null;
  resolutionReason: DuplicateReason | null;
  version: number;
  external: 'onec' | null;
  members: DuplicateMemberView[];
}

export interface DuplicateList {
  items: DuplicateCaseView[];
  total: number;
  counts: Record<DuplicateStatus, number>;
}

interface CaseRow {
  case_id: string; rule_code: string; entity_kind: DuplicateEntityKind; strength: 'exact' | 'likely'; status: DuplicateStatus; key_mask: string | null;
  first_detected_at: Date; last_seen_at: Date; detected_via: string; resolved_at: Date | null; resolved_by: string | null; resolved_by_name: string | null;
  resolution_code: string | null; resolution_reason: DuplicateReason | null; version: number; sources: string; total?: string;
}

interface MemberRow {
  case_id: string; system: DuplicateSystem; entity_kind: DuplicateEntityKind; record_key: string; erp_entity_id: string | null; joined_at: Date;
  left_at: Date | null; record_created_at: Date | null; record_author_user_id: string | null; author_name: string | null;
  record_author_external: string | null; record_via: string;
}

/** Name reads per kind: `$1` — ids (text). Persons among clients and 1C counterparties are flagged. */
const NAME_SQL: Record<DuplicateEntityKind, string> = {
  client: `SELECT client_id::text AS id, client_name::text AS name, person_type = 'individual' AS personal FROM clients WHERE client_id::text = ANY($1)`,
  supplier: `SELECT supplier_id::text AS id, supplier_name AS name, false AS personal FROM suppliers WHERE supplier_id::text = ANY($1)`,
  vendor: `SELECT vendor_id::text AS id, vendor_name AS name, false AS personal FROM vendors WHERE vendor_id::text = ANY($1)`,
  film: `SELECT film_id::text AS id, film_name AS name, false AS personal FROM films WHERE film_id::text = ANY($1)`,
  sheet_material: `SELECT sheet_material_type_id::text AS id, name, false AS personal FROM sheet_material_types WHERE sheet_material_type_id::text = ANY($1)`,
  material: `SELECT material_id::text AS id, material_name AS name, false AS personal FROM materials WHERE material_id::text = ANY($1)`,
  onec_counterparty: `SELECT m.source_id || ':' || lower(m.source_key) AS id, m.data->>'Description' AS name,
    COALESCE(m.data->>'ВидКонтрагента', '') IN ('ФизическоеЛицо', 'ИндивидуальныйПредприниматель') AS personal
    FROM onec_etl_mirror_rows m WHERE m.entity_code = 'counterparties' AND m.source_id || ':' || lower(m.source_key) = ANY($1)`,
  onec_item: `SELECT m.source_id || ':' || lower(m.source_key) AS id, m.data->>'Description' AS name, false AS personal
    FROM onec_etl_mirror_rows m WHERE m.entity_code = 'items' AND m.source_id || ':' || lower(m.source_key) = ANY($1)`,
};

/** Text search over names, per kind the reader may see: `$1` — the pattern. */
const SEARCH_SQL: Record<DuplicateEntityKind, string> = {
  client: `m.entity_kind = 'client' AND m.system = 'erp' AND EXISTS (SELECT 1 FROM clients x WHERE x.client_id = m.erp_entity_id AND x.client_name::text ILIKE $P ESCAPE '\\')`,
  supplier: `m.entity_kind = 'supplier' AND EXISTS (SELECT 1 FROM suppliers x WHERE x.supplier_id = m.erp_entity_id AND x.supplier_name ILIKE $P ESCAPE '\\')`,
  vendor: `m.entity_kind = 'vendor' AND EXISTS (SELECT 1 FROM vendors x WHERE x.vendor_id = m.erp_entity_id AND x.vendor_name ILIKE $P ESCAPE '\\')`,
  film: `m.entity_kind = 'film' AND EXISTS (SELECT 1 FROM films x WHERE x.film_id = m.erp_entity_id AND x.film_name ILIKE $P ESCAPE '\\')`,
  sheet_material: `m.entity_kind = 'sheet_material' AND EXISTS (SELECT 1 FROM sheet_material_types x WHERE x.sheet_material_type_id = m.erp_entity_id AND x.name ILIKE $P ESCAPE '\\')`,
  material: `m.entity_kind = 'material' AND EXISTS (SELECT 1 FROM materials x WHERE x.material_id = m.erp_entity_id AND x.material_name ILIKE $P ESCAPE '\\')`,
  onec_counterparty: `m.entity_kind = 'onec_counterparty' AND EXISTS (SELECT 1 FROM onec_etl_mirror_rows x WHERE x.entity_code = 'counterparties'
    AND x.source_id || ':' || lower(x.source_key) = m.record_key AND x.data->>'Description' ILIKE $P ESCAPE '\\' AND $CURRENT
    AND ($PERSONS OR COALESCE(x.data->>'ВидКонтрагента', '') NOT IN ('ФизическоеЛицо', 'ИндивидуальныйПредприниматель')))`,
  onec_item: `m.entity_kind = 'onec_item' AND EXISTS (SELECT 1 FROM onec_etl_mirror_rows x WHERE x.entity_code = 'items'
    AND x.source_id || ':' || lower(x.source_key) = m.record_key AND x.data->>'Description' ILIKE $P ESCAPE '\\' AND $CURRENT)`,
};

/** Names of 1C members are searched (as they are shown) only while the 1C data the case rests on is current. */
const SOURCES_CURRENT = `NOT EXISTS (SELECT 1 FROM integration_duplicate_case_sources cs WHERE cs.case_id = m.case_id
    AND onec_entity_snapshot_state(cs.source_id, cs.entity_code, cs.snapshot_version) <> 'current')`;

// No dependency at all — 'none' (the aggregate over no rows must not read as «refreshing»).
const SOURCES_STATE = `COALESCE((SELECT CASE WHEN count(*) = 0 THEN NULL WHEN bool_and(s.state = 'current') THEN 'current' WHEN bool_or(s.state IN ('revoked', 'expired', 'missing')) THEN 'unavailable'
    ELSE 'refreshing' END FROM (SELECT onec_entity_snapshot_state(cs.source_id, cs.entity_code, cs.snapshot_version) AS state
    FROM integration_duplicate_case_sources cs WHERE cs.case_id = c.case_id) s), 'none')`;

const CASE_COLUMNS = `c.case_id, c.rule_code, c.entity_kind, c.strength, c.status, c.key_mask, c.first_detected_at, c.last_seen_at, c.detected_via,
  c.resolved_at, c.resolved_by, ru.username::text AS resolved_by_name, c.resolution_code, c.resolution_reason, c.version, ${SOURCES_STATE} AS sources`;

const can = (user: CurrentUser, permission: string) => (user.permissions as readonly string[]).includes(permission);

/**
 * Reads of the journal and the decisions of users. Names and values are read live, each by the right of its source;
 * numbers about orders count only orders the reader may see.
 */
@Injectable()
export class DuplicateJournalRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DuplicateEngineRepository) private readonly engine: DuplicateEngineRepository,
  ) {}

  async list(user: CurrentUser, query: DuplicateListQuery): Promise<DuplicateList> {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => `$${params.push(value)}`;
    if (query.entityKind) where.push(`c.entity_kind = ${add(query.entityKind)}`);
    if (query.ruleCode) where.push(`c.rule_code = ${add(query.ruleCode)}`);
    // Bitrix24 records live in ERP (clients that came from Bitrix keep their ERP identity): the filter is by their origin.
    if (query.system === 'bitrix') where.push(`EXISTS (SELECT 1 FROM integration_duplicate_members m WHERE m.case_id = c.case_id AND m.left_at IS NULL AND m.record_via = 'bitrix_inbound')`);
    else if (query.system) where.push(`EXISTS (SELECT 1 FROM integration_duplicate_members m WHERE m.case_id = c.case_id AND m.left_at IS NULL AND m.system = ${add(query.system)})`);
    if (query.from) where.push(`c.last_seen_at >= ${add(query.from)}`);
    if (query.to) where.push(`c.first_detected_at <= ${add(query.to)}`);
    if (query.search) where.push(this.searchPredicate(user, query.search, add));
    const filtered = where.length ? where.join(' AND ') : 'TRUE';
    const counts = Object.fromEntries((['open', 'dismissed', 'external', 'merged', 'resolved'] as const).map((s) => [s, 0])) as Record<DuplicateStatus, number>;
    for (const row of (await this.database.query<{ status: DuplicateStatus; n: number }>(
      `SELECT c.status, count(*)::int AS n FROM integration_duplicate_cases c WHERE ${filtered} GROUP BY c.status`, params)).rows) counts[row.status] = row.n;
    const statusSql = query.status === 'all' ? 'TRUE' : `c.status = ${add(query.status)}`;
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const rows = (await this.database.query<CaseRow>(
      `SELECT ${CASE_COLUMNS}, count(*) OVER () AS total
         FROM integration_duplicate_cases c LEFT JOIN users ru ON ru.user_id = c.resolved_by
        WHERE ${filtered} AND ${statusSql}
        ORDER BY c.last_seen_at DESC, c.case_id DESC LIMIT ${limit} OFFSET ${offset}`, params)).rows;
    const members = await this.members(rows.map((row) => Number(row.case_id)), true);
    const items = await this.views(user, rows, members);
    return { items, total: rows[0]?.total ? Number(rows[0].total) : 0, counts };
  }

  async card(user: CurrentUser, caseId: number) {
    const row = (await this.database.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM integration_duplicate_cases c LEFT JOIN users ru ON ru.user_id = c.resolved_by WHERE c.case_id = $1`, [caseId])).rows[0];
    if (!row) throw new ApiError(404, 'DUPLICATE_CASE_NOT_FOUND', 'Дело дубля не найдено');
    const members = await this.members([caseId], false);
    const [view] = await this.views(user, [row], members);
    const current = view.sourcesState === 'none' || view.sourcesState === 'current';
    const details = [];
    for (const member of view.members) details.push({ ...member, ...(await this.memberDetails(user, member, current)) });
    const values = current ? await this.matchedValues(user, row, view.members) : new Map<string, string[]>();
    const history = (await this.database.query<{ event_id: string; action: string; actor_user_id: string | null; username: string | null; created_at: Date; details: Record<string, unknown> }>(
      `SELECT e.event_id, e.action, e.actor_user_id, u.username::text AS username, e.created_at, e.details
         FROM integration_duplicate_events e LEFT JOIN users u ON u.user_id = e.actor_user_id WHERE e.case_id = $1 ORDER BY e.event_id DESC LIMIT 200`,
      [caseId])).rows.map((e) => ({
      eventId: Number(e.event_id), action: e.action, at: e.created_at.toISOString(),
      actor: e.actor_user_id === null ? null : { userId: Number(e.actor_user_id), username: e.username },
      reason: typeof e.details.reason === 'string' ? e.details.reason : null,
      members: Array.isArray(e.details.members) ? (e.details.members as MemberRef[]).map((m) => ({ system: m.system, entityKind: m.entityKind, recordKey: m.recordKey })) : [],
    }));
    const related = (await this.database.query<{ case_id: string; rule_code: string; status: string }>(
      `SELECT DISTINCT c.case_id, c.rule_code, c.status FROM integration_duplicate_members m JOIN integration_duplicate_cases c ON c.case_id = m.case_id
        WHERE (m.system, m.entity_kind, m.record_key) IN (SELECT system, entity_kind, record_key FROM integration_duplicate_members WHERE case_id = $1)
          AND c.case_id <> $1 ORDER BY c.case_id DESC LIMIT 50`, [caseId])).rows
      .map((r) => ({ caseId: Number(r.case_id), ruleCode: r.rule_code, ruleLabel: RULES_BY_CODE.get(r.rule_code)?.label ?? r.rule_code, status: r.status }));
    return {
      ...view,
      members: details.map((member) => ({ ...member, matchedValues: values.get(`${member.system}:${member.entityKind}:${member.recordKey}`) ?? null })),
      history, related,
    };
  }

  /** «Не дубль», «Исправить в 1С», «Открыть снова» — compare-and-swap on the version of the case. */
  async decide(user: CurrentUser, caseId: number, action: 'dismiss' | 'external' | 'reopen', expectedVersion: number, reason: DuplicateReason | null, requestId: string) {
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<{ case_id: string; rule_code: string; entity_kind: string; status: DuplicateStatus; version: number }>(
        'SELECT case_id, rule_code, entity_kind, status, version FROM integration_duplicate_cases WHERE case_id = $1 FOR UPDATE', [caseId])).rows[0];
      if (!row) throw new ApiError(404, 'DUPLICATE_CASE_NOT_FOUND', 'Дело дубля не найдено');
      if (row.version !== expectedVersion) {
        throw new ApiError(409, 'DUPLICATE_CASE_CHANGED', 'Дело дубля уже изменилось; обновите страницу', { version: row.version, status: row.status });
      }
      const rule = RULES_BY_CODE.get(row.rule_code);
      const allowed: Record<typeof action, DuplicateStatus[]> = { dismiss: ['open'], external: ['open'], reopen: ['dismissed', 'external'] };
      if (!allowed[action].includes(row.status)) {
        throw new ApiError(409, 'DUPLICATE_CASE_STATE', 'Это действие недоступно для дела в текущем состоянии', { status: row.status });
      }
      if (action === 'external' && rule?.external !== 'onec') {
        throw new ApiError(422, 'DUPLICATE_CASE_NOT_EXTERNAL', 'Этот дубль исправляется в ERP, а не в 1С');
      }
      const status: DuplicateStatus = action === 'dismiss' ? 'dismissed' : action === 'external' ? 'external' : 'open';
      await tx.query(
        `UPDATE integration_duplicate_cases SET status = $2, resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END,
                resolved_by = CASE WHEN $2 = 'open' THEN NULL ELSE $3::bigint END, resolution_code = CASE WHEN $2 = 'open' THEN NULL ELSE $4 END,
                resolution_reason = $5, decision_status = CASE WHEN $2 = 'open' THEN NULL ELSE $2 END,
                decision_by = CASE WHEN $2 = 'open' THEN NULL ELSE $3::bigint END, decision_reason = $5,
                version = version + 1, updated_at = now() WHERE case_id = $1`,
        [caseId, status, Number(user.id), action === 'dismiss' ? 'not_duplicate' : action === 'external' ? 'fix_in_onec' : null, action === 'reopen' ? null : reason]);
      const members = (await tx.query<{ system: DuplicateSystem; entity_kind: DuplicateEntityKind; record_key: string; erp_entity_id: string | null }>(
        'SELECT system, entity_kind, record_key, erp_entity_id FROM integration_duplicate_members WHERE case_id = $1 AND left_at IS NULL', [caseId])).rows
        .map((m) => ({ system: m.system, entityKind: m.entity_kind, recordKey: m.record_key, erpEntityId: m.erp_entity_id === null ? null : Number(m.erp_entity_id) }));
      await recordTransition(tx, { caseId, ruleCode: row.rule_code, entityKind: row.entity_kind, status },
        action === 'dismiss' ? 'dismissed' : action === 'external' ? 'marked_external' : 'reopened',
        { requestId, correlationId: requestId, actor: user }, members, { previousStatus: row.status, reason: action === 'reopen' ? 'user' : reason ?? undefined });
    });
    return this.card(user, caseId);
  }

  private searchPredicate(user: CurrentUser, search: string, add: (value: unknown) => string): string {
    const parts: string[] = [];
    if (/^\d{1,18}$/.test(search)) {
      const id = add(search);
      parts.push(`c.case_id::text = ${id}`);
      parts.push(`EXISTS (SELECT 1 FROM integration_duplicate_members m WHERE m.case_id = c.case_id AND m.erp_entity_id::text = ${id})`);
    }
    const kinds = DUPLICATE_ENTITY_KINDS.filter((kind) => can(user, KIND_VIEW_PERMISSION[kind]));
    // The pattern is a parameter only when some kind may be searched by name (an unused parameter breaks the query).
    const pattern = kinds.length ? add(`%${search.replace(/[\\%_]/g, '\\$&')}%`) : '';
    const persons = can(user, ONEC_VALUES_PERMISSION) ? 'TRUE' : 'FALSE';
    const byName = kinds.map((kind) => SEARCH_SQL[kind].replaceAll('$PERSONS', () => persons).replaceAll('$CURRENT', () => SOURCES_CURRENT).replaceAll('$P', () => pattern));
    if (byName.length) parts.push(`EXISTS (SELECT 1 FROM integration_duplicate_members m WHERE m.case_id = c.case_id AND ((${byName.join(') OR (')})))`);
    return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
  }

  private async members(caseIds: number[], activeOnly: boolean): Promise<MemberRow[]> {
    if (!caseIds.length) return [];
    return (await this.database.query<MemberRow>(
      `SELECT m.case_id, m.system, m.entity_kind, m.record_key, m.erp_entity_id, m.joined_at, m.left_at, m.record_created_at,
              m.record_author_user_id, u.username::text AS author_name, m.record_author_external, m.record_via
         FROM integration_duplicate_members m LEFT JOIN users u ON u.user_id = m.record_author_user_id
        WHERE m.case_id = ANY($1::bigint[]) ${activeOnly ? 'AND m.left_at IS NULL' : ''}
        ORDER BY m.case_id, m.left_at NULLS FIRST, m.joined_at, m.record_key`, [caseIds])).rows;
  }

  private async views(user: CurrentUser, rows: CaseRow[], members: MemberRow[]): Promise<DuplicateCaseView[]> {
    const names = await this.names(user, members);
    return rows.map((row) => {
      const rule = RULES_BY_CODE.get(row.rule_code);
      const sourcesState = row.sources as DuplicateCaseView['sourcesState'];
      const current = sourcesState === 'none' || sourcesState === 'current';
      return {
        caseId: Number(row.case_id), ruleCode: row.rule_code, ruleLabel: rule?.label ?? row.rule_code,
        entityKind: row.entity_kind, entityKindLabel: ENTITY_KIND_LABELS[row.entity_kind] ?? row.entity_kind,
        strength: row.strength, status: row.status, keyMask: current ? row.key_mask : null, sourcesState,
        firstDetectedAt: row.first_detected_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), detectedVia: row.detected_via,
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        resolvedBy: row.resolved_by === null ? null : { userId: Number(row.resolved_by), username: row.resolved_by_name },
        resolutionCode: row.resolution_code, resolutionReason: row.resolution_reason, version: row.version, external: rule?.external ?? null,
        members: members.filter((m) => m.case_id === row.case_id).map((m) => ({
          system: m.system, entityKind: m.entity_kind, recordKey: m.record_key, erpEntityId: m.erp_entity_id === null ? null : Number(m.erp_entity_id),
          // A member of 1C is named only while the data the case rests on is current.
          name: m.system === 'onec' && !current ? null : names.get(`${m.entity_kind}:${m.record_key}`) ?? null,
          joinedAt: m.joined_at.toISOString(), leftAt: m.left_at?.toISOString() ?? null, recordCreatedAt: m.record_created_at?.toISOString() ?? null,
          author: m.record_author_user_id === null ? null : { userId: Number(m.record_author_user_id), username: m.author_name },
          authorExternal: m.record_author_external, via: m.record_via,
        })),
      };
    });
  }

  /** Names by the right of each kind; a person (an individual client, a person in 1C) needs the client / 1C data rights. */
  private async names(user: CurrentUser, members: MemberRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const onec = await this.onecInstalled();
    for (const kind of DUPLICATE_ENTITY_KINDS) {
      if (!can(user, KIND_VIEW_PERMISSION[kind])) continue;
      if ((kind === 'onec_counterparty' || kind === 'onec_item') && !onec) continue;
      const ids = [...new Set(members.filter((m) => m.entity_kind === kind).map((m) => m.record_key))];
      if (!ids.length) continue;
      for (const row of (await this.database.query<{ id: string; name: string | null; personal: boolean }>(NAME_SQL[kind], [ids])).rows) {
        if (row.personal && kind === 'onec_counterparty' && !can(user, ONEC_VALUES_PERMISSION)) continue;
        if (row.name) out.set(`${kind}:${row.id}`, row.name);
      }
    }
    return out;
  }

  /** The values a member shares with the others, by the right of their source (only while the 1C data is current). */
  private async matchedValues(user: CurrentUser, row: CaseRow, members: DuplicateMemberView[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const rule = RULES_BY_CODE.get(row.rule_code);
    // Without the secret (the search is off) the values cannot be matched to the key: the journal is read without them.
    if (!rule || row.key_mask === null || rule.maskKind === 'pair' || !this.engine.hasSecret()) return out;
    const env = await this.engine.ruleEnv();
    const hash = (await this.database.query<{ key_hash: Buffer | null }>('SELECT key_hash FROM integration_duplicate_cases WHERE case_id = $1', [row.case_id])).rows[0]?.key_hash;
    if (!hash) return out;
    for (const member of members.filter((m) => m.leftAt === null)) {
      if (!can(user, KIND_VIEW_PERMISSION[member.entityKind])) continue;
      const rows = (await this.engine.runRule(rule, env, { record: member })).filter((r) => this.engine.hash(rule, r.key).equals(hash));
      // Who shows the value does not matter: a value of 1C (a counterparty name, an IIN, a phone of the mirror) needs the right.
      const fromOnec = member.system === 'onec' || rule.valueFromOnec === true || rows.some((r) => r.dep_entity !== null);
      if (fromOnec && !can(user, ONEC_VALUES_PERMISSION)) continue;
      if (rows.some((r) => r.personal) && member.entityKind === 'client' && !can(user, 'clients.view')) continue;
      if (rows.length) out.set(`${member.system}:${member.entityKind}:${member.recordKey}`, [...new Set(rows.map((r) => displayKey(rule.maskKind, r.key)))]);
    }
    return out;
  }

  /** What is attached to a member — each number only by the right of its screen, orders only those the reader may see. */
  private async memberDetails(user: CurrentUser, member: DuplicateMemberView, current: boolean): Promise<{ facts: Array<{ label: string; value: string | number | null; hidden?: boolean }> }> {
    const facts: Array<{ label: string; value: string | number | null; hidden?: boolean }> = [];
    const hidden = (label: string) => facts.push({ label, value: null, hidden: true });
    const id = member.erpEntityId;
    const db: DatabaseClient = this.database;
    if (member.system === 'erp' && id !== null) {
      const orderColumn: Partial<Record<DuplicateEntityKind, string>> = { client: 'o.client_id', film: 'd.film_id', sheet_material: 'd.sheet_material_type_id', material: 'd.material_id' };
      if (member.entityKind === 'client') {
        if (can(user, 'orders.view')) {
          const params: unknown[] = [id];
          const visibility = appendOrderReadVisibilitySql(params, user, 'o');
          const orders = (await db.query<{ n: number; last_id: string | null; last_name: string | null; last_date: Date | null }>(
            `SELECT count(*)::int AS n, (array_agg(o.order_id ORDER BY o.created_at DESC))[1] AS last_id,
                    (array_agg(o.order_name ORDER BY o.created_at DESC))[1] AS last_name, max(o.created_at)::timestamptz AS last_date
               FROM orders o WHERE o.client_id = $1 AND o.deleted_at IS NULL AND ${visibility}`, params)).rows[0];
          facts.push({ label: 'Заказов', value: orders.n });
          if (orders.last_id) facts.push({ label: 'Последний заказ', value: `${orders.last_name ?? orders.last_id} (${orders.last_date?.toISOString().slice(0, 10) ?? ''})` });
          if (can(user, 'orders.view_financials')) {
            const paid = (await db.query<{ sum: string | null }>(
              `SELECT sum(p.amount)::text AS sum FROM payments p JOIN orders o ON o.order_id = p.order_id
                WHERE o.client_id = $1 AND o.deleted_at IS NULL AND NOT COALESCE(p.delete_flag, false) AND ${visibility}`, params)).rows[0];
            facts.push({ label: 'Оплачено', value: paid.sum ?? '0' });
          } else hidden('Оплачено');
        } else hidden('Заказов');
        if (can(user, 'clients.view')) {
          const c = (await db.query<{ phones: number; ref: string | null; bitrix: string | null; active: boolean }>(
            `SELECT (SELECT count(*)::int FROM client_phones p WHERE p.client_id = c.client_id) AS phones, lower(c.ref_key_1c::text) AS ref, c.is_active AS active,
                    (SELECT mp.bitrix_object || ' ' || mp.bitrix_id FROM crm_sync_mapping mp WHERE mp.entity_type = 'client' AND mp.erp_id = c.client_id::text LIMIT 1) AS bitrix
               FROM clients c WHERE c.client_id = $1`, [id])).rows[0];
          if (c) {
            facts.push({ label: 'Телефонов', value: c.phones }, { label: 'Связь с 1С', value: c.ref ? 'есть' : 'нет' },
              { label: 'Bitrix24', value: c.bitrix }, { label: 'Активен', value: c.active ? 'да' : 'нет' });
          }
        }
      } else if (member.entityKind === 'supplier') {
        if (can(user, 'suppliers.view')) {
          const s = (await db.query<{ contacts: number; ref: string | null }>(
            `SELECT (SELECT count(*)::int FROM supplier_contacts x WHERE x.supplier_id = s.supplier_id AND x.origin = 'erp') AS contacts, lower(s.ref_key_1c::text) AS ref
               FROM suppliers s WHERE s.supplier_id = $1`, [id])).rows[0];
          if (s) facts.push({ label: 'Контактов', value: s.contacts }, { label: 'Связь с 1С', value: s.ref ? 'есть' : 'нет' });
        }
        if (can(user, 'procurement.view') && (await this.tableExists('onec_documents'))) {
          facts.push({ label: 'Документов 1С', value: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM onec_documents WHERE supplier_id = $1', [id])).rows[0].n });
        } else hidden('Документов 1С');
        if (can(user, 'sheet_materials.view')) {
          facts.push({ label: 'Листовых материалов', value: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sheet_material_types WHERE supplier_id = $1', [id])).rows[0].n });
        }
      } else if (member.entityKind === 'vendor') {
        if (can(user, 'references.view')) facts.push({ label: 'Плёнок', value: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM films WHERE vendor_id = $1', [id])).rows[0].n });
        if (can(user, 'sheet_materials.view')) facts.push({ label: 'Листовых материалов', value: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sheet_material_types WHERE vendor_id = $1', [id])).rows[0].n });
      }
      const column = orderColumn[member.entityKind];
      if (column && member.entityKind !== 'client') {
        if (can(user, 'orders.view')) {
          const params: unknown[] = [id];
          const visibility = appendOrderReadVisibilitySql(params, user, 'o');
          const lines = (await db.query<{ lines: number; orders: number }>(
            `SELECT count(*)::int AS lines, count(DISTINCT o.order_id)::int AS orders FROM order_details d JOIN orders o ON o.order_id = d.order_id
              WHERE ${column} = $1 AND NOT COALESCE(d.delete_flag, false) AND o.deleted_at IS NULL AND ${visibility}`, params)).rows[0];
          facts.push({ label: 'Деталей в заказах', value: lines.lines }, { label: 'Заказов', value: lines.orders });
        } else hidden('Деталей в заказах');
      }
    } else if (member.system === 'onec' && current && can(user, 'onec.view') && (await this.onecInstalled())) {
      const [source, ref] = member.recordKey.split(':');
      const entity = member.entityKind === 'onec_item' ? 'items' : 'counterparties';
      const row = (await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2 AND lower(source_key) = $3`, [Number(source), entity, ref])).rows[0];
      if (row) {
        // JSON of the mirror: flags are booleans (or strings), the rest are strings.
        const text = (name: string) => { const value = row.data[name]; return value === null || value === undefined ? null : String(value); };
        const flag = (name: string) => (String(row.data[name]) === 'true' ? 'да' : 'нет');
        facts.push({ label: 'Код 1С', value: text('Code') });
        if (entity === 'counterparties') {
          facts.push({ label: 'Вид', value: text('ВидКонтрагента') }, { label: 'Покупатель', value: flag('Покупатель') }, { label: 'Поставщик', value: flag('Поставщик') });
          if (can(user, ONEC_VALUES_PERMISSION)) facts.push({ label: 'ИИН/БИН', value: text('ИдентификационныйНомер') });
          else hidden('ИИН/БИН');
          if (can(user, 'clients.view')) {
            const linked = (await db.query<{ id: string; name: string }>(
              `SELECT client_id::text AS id, client_name::text AS name FROM clients WHERE lower(ref_key_1c::text) = $1 AND ${linkSourceSql('$1')} = $2`, [ref, Number(source)])).rows[0];
            facts.push({ label: 'Клиент ERP', value: linked ? `${linked.name} (#${linked.id})` : 'нет' });
          }
          if (can(user, 'suppliers.view')) {
            const linked = (await db.query<{ id: string; name: string }>(
              `SELECT supplier_id::text AS id, supplier_name AS name FROM suppliers WHERE lower(ref_key_1c::text) = $1 AND ${linkSourceSql('$1')} = $2`, [ref, Number(source)])).rows[0];
            facts.push({ label: 'Поставщик ERP', value: linked ? `${linked.name} (#${linked.id})` : 'нет' });
          }
        } else {
          facts.push({ label: 'Артикул', value: text('Артикул') });
        }
      }
    }
    return { facts };
  }

  private async onecInstalled(): Promise<boolean> {
    return this.tableExists('onec_etl_mirror_rows');
  }

  private async tableExists(name: string): Promise<boolean> {
    return (await this.database.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0]?.ok === true;
  }
}

/** A matched key for a reader allowed to see it: a phone with its prefix, the rest as normalized. */
function displayKey(kind: string, key: string): string {
  if (kind === 'phone') return `+7 ${key.slice(0, 3)} ${key.slice(3, 6)} ${key.slice(6, 8)} ${key.slice(8)}`;
  if (kind === 'composite') return key.split(':')[0] ?? key;
  return key;
}
