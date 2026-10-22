import { createHash } from 'node:crypto';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import { normalizedPhone } from '../onec-agent/domain/onec-matching-sql';

/** The state of two clients that a merge reads, locks, fingerprints and changes. Values stay on the server. */
export interface ClientState {
  clientId: number;
  name: string;
  personType: string;
  isActive: boolean;
  notes: string | null;
  ref: string | null;
  updatedAt: string;
  createdAt: string;
  createdBy: number | null;
  createdByName: string | null;
  contactsVersion: number;
  merged: boolean;
}

export interface ProjectState { projectId: number; version: number; clientId: number; deleted: boolean; orderIds: number[] }
export interface OrderState {
  orderId: number; version: number; projectId: number | null; clientId: number; name: string; deleted: boolean;
  createdBy: string | null; managerId: string | null;
}
export interface PhoneState {
  phoneId: number; clientId: number; number: string; type: string | null; isPrimary: boolean; ref: string | null; key: string;
}
export interface ContactState {
  contactId: number; clientId: number; kind: string; value: string; valueNormalized: string; isPrimary: boolean; note: string | null;
  position: number; origin: string;
  /** A copy of 1C contacts (K4b): its source, snapshot and sync time as stored, and the key of the profile it was made for. */
  onecSourceId: number | null; onecSnapshotVersion: string | null; onecSyncedAt: string | null; onecRefKey1c: string | null;
}
export interface MappingState { clientId: number; bitrixObject: string; bitrixId: string | null; status: string }

export interface PairState {
  survivor: ClientState;
  merged: ClientState;
  projects: ProjectState[];
  orders: OrderState[];
  phones: PhoneState[];
  contacts: ContactState[];
  mappings: MappingState[];
  bitrixRequests: number;
  whatsappPending: number;
  groupLinks: number;
  standaloneDeadlines: number;
}

const toNum = (value: unknown): number => Number(value);
const toNullNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const toNullStr = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export async function readClients(db: DatabaseClient, ids: number[], lock: boolean): Promise<Map<number, ClientState>> {
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT c.client_id, c.client_name::text AS client_name, c.person_type, c.is_active, c.notes, lower(c.ref_key_1c::text) AS ref,
            c.updated_at::text AS updated_at, c.created_at::text AS created_at, c.created_by, u.username::text AS created_by_name,
            COALESCE(v.version, 0) AS contacts_version,
            EXISTS (SELECT 1 FROM client_merge_redirects r WHERE r.merged_client_id = c.client_id) AS merged
       FROM clients c
       LEFT JOIN users u ON u.user_id = c.created_by
       LEFT JOIN party_contact_versions v ON v.party_kind = 'client' AND v.party_id = c.client_id
      WHERE c.client_id = ANY($1::bigint[])
      ORDER BY c.client_id ${lock ? 'FOR UPDATE OF c' : ''}`, [ids])).rows;
  return new Map(rows.map((r) => [toNum(r.client_id), {
    clientId: toNum(r.client_id), name: String(r.client_name), personType: String(r.person_type), isActive: r.is_active === true,
    notes: toNullStr(r.notes), ref: toNullStr(r.ref), updatedAt: String(r.updated_at), createdAt: String(r.created_at),
    createdBy: toNullNum(r.created_by), createdByName: toNullStr(r.created_by_name), contactsVersion: toNum(r.contacts_version), merged: r.merged === true,
  }]));
}

export async function readProjects(db: DatabaseClient, clientId: number, lock: boolean): Promise<ProjectState[]> {
  return (await db.query<Record<string, unknown>>(
    `SELECT p.project_id, p.version, p.client_id, p.delete_flag,
            COALESCE((SELECT array_agg(o.order_id ORDER BY o.order_id) FROM orders o WHERE o.project_id = p.project_id), '{}') AS order_ids
       FROM projects p WHERE p.client_id = $1 ORDER BY p.project_id ${lock ? 'FOR NO KEY UPDATE OF p' : ''}`, [clientId])).rows
    .map((r) => ({ projectId: toNum(r.project_id), version: toNum(r.version), clientId: toNum(r.client_id), deleted: r.delete_flag === true,
      orderIds: (r.order_ids as unknown[]).map(toNum) }));
}

export async function readOrders(db: DatabaseClient, where: { clientId: number } | { orderIds: number[] }, lock: boolean): Promise<OrderState[]> {
  const byClient = 'clientId' in where;
  return (await db.query<Record<string, unknown>>(
    `SELECT o.order_id, o.version, o.project_id, o.client_id, o.order_name::text AS order_name, o.delete_flag, o.created_by, o.manager_id
       FROM orders o WHERE ${byClient ? 'o.client_id = $1' : 'o.order_id = ANY($1::bigint[])'}
      ORDER BY o.order_id ${lock ? 'FOR NO KEY UPDATE OF o' : ''}`, [byClient ? where.clientId : where.orderIds])).rows
    .map((r) => ({
      orderId: toNum(r.order_id), version: toNum(r.version), projectId: toNullNum(r.project_id), clientId: toNum(r.client_id),
      name: String(r.order_name ?? ''), deleted: r.delete_flag === true, createdBy: toNullStr(r.created_by), managerId: toNullStr(r.manager_id),
    }));
}

export async function readPhones(db: DatabaseClient, clientIds: number[], lock: boolean): Promise<PhoneState[]> {
  return (await db.query<Record<string, unknown>>(
    `SELECT p.phone_id, p.client_id, p.phone_number, p.phone_type, COALESCE(p.is_primary, false) AS is_primary, lower(p.ref_key_1c::text) AS ref,
            ${normalizedPhone('p.phone_number')} AS k
       FROM client_phones p WHERE p.client_id = ANY($1::bigint[]) ORDER BY p.phone_id ${lock ? 'FOR UPDATE OF p' : ''}`, [clientIds])).rows
    .map((r) => ({
      phoneId: toNum(r.phone_id), clientId: toNum(r.client_id), number: String(r.phone_number), type: toNullStr(r.phone_type),
      isPrimary: r.is_primary === true, ref: toNullStr(r.ref), key: String(r.k ?? ''),
    }));
}

export async function readContacts(db: DatabaseClient, clientIds: number[], lock: boolean): Promise<ContactState[]> {
  return (await db.query<Record<string, unknown>>(
    `SELECT c.contact_id, c.client_id, c.kind, c.value, c.value_normalized, c.is_primary, c.note, c.position, c.origin,
            c.onec_source_id, c.onec_snapshot_version::text AS onec_snapshot_version, c.onec_synced_at::text AS onec_synced_at,
            (SELECT lower(p.ref_key_1c::text) FROM party_onec_profiles p
              WHERE p.party_kind = 'client' AND p.party_id = c.client_id AND p.source_id = c.onec_source_id) AS onec_ref
       FROM client_contacts c WHERE c.client_id = ANY($1::bigint[]) ORDER BY c.contact_id ${lock ? 'FOR UPDATE OF c' : ''}`, [clientIds])).rows
    .map((r) => ({
      contactId: toNum(r.contact_id), clientId: toNum(r.client_id), kind: String(r.kind), value: String(r.value), valueNormalized: String(r.value_normalized),
      isPrimary: r.is_primary === true, note: toNullStr(r.note), position: toNum(r.position), origin: String(r.origin),
      onecSourceId: toNullNum(r.onec_source_id), onecSnapshotVersion: toNullStr(r.onec_snapshot_version), onecSyncedAt: toNullStr(r.onec_synced_at),
      onecRefKey1c: toNullStr(r.onec_ref),
    }));
}

export async function readMappings(db: DatabaseClient, clientIds: number[]): Promise<MappingState[]> {
  return (await db.query<Record<string, unknown>>(
    `SELECT erp_id, bitrix_object, bitrix_id, status FROM crm_sync_mapping
      WHERE entity_type = 'client' AND erp_id = ANY($1::text[]) ORDER BY erp_id, bitrix_object, bitrix_id`, [clientIds.map(String)])).rows
    .map((r) => ({ clientId: toNum(r.erp_id), bitrixObject: String(r.bitrix_object), bitrixId: toNullStr(r.bitrix_id), status: String(r.status) }));
}

/** Counts that are obstacles of a merge: Bitrix requests, unfinished WhatsApp sends, links to access groups, deadlines without an order. */
export async function readBlockers(db: DatabaseClient, mergedId: number, orderIds: number[], phoneIds: number[]) {
  const row = (await db.query<{ requests: number; sends: number; links: number; deadlines: number }>(
    `SELECT (SELECT count(*)::int FROM bitrix24_incoming_request WHERE client_id = $1) AS requests,
            (SELECT count(*)::int FROM whatsapp_order_sends s
              WHERE s.state IN ('queued', 'sending', 'unknown')
                AND (s.client_id = $1 OR s.order_id = ANY($2::bigint[]) OR s.client_phone_id = ANY($3::bigint[]))) AS sends,
            (SELECT count(*)::int FROM group_entity_links WHERE entity_type_code = 'client' AND entity_id_text = $1::text) AS links,
            (SELECT count(*)::int FROM deadline_instances WHERE order_id IS NULL AND client_id = $1) AS deadlines`,
    [mergedId, orderIds, phoneIds])).rows[0];
  return { bitrixRequests: row.requests, whatsappPending: row.sends, groupLinks: row.links, standaloneDeadlines: row.deadlines };
}

export async function readPair(db: DatabaseClient, survivorId: number, mergedId: number): Promise<PairState | null> {
  const clients = await readClients(db, [survivorId, mergedId], false);
  const survivor = clients.get(survivorId);
  const merged = clients.get(mergedId);
  if (!survivor || !merged) return null;
  const projects = await readProjects(db, mergedId, false);
  const orders = await readOrders(db, { clientId: mergedId }, false);
  const phones = await readPhones(db, [survivorId, mergedId], false);
  const contacts = await readContacts(db, [survivorId, mergedId], false);
  const mappings = await readMappings(db, [survivorId, mergedId]);
  const blockers = await readBlockers(db, mergedId, orders.map((o) => o.orderId), phones.filter((p) => p.clientId === mergedId).map((p) => p.phoneId));
  return { survivor, merged, projects, orders, phones, contacts, mappings, ...blockers };
}

/**
 * The advisory keys a merge takes before any row lock, sorted: the one operation of merges, the 1C link key of the merged
 * client (as `setLink`), every key the Bitrix reverse sync takes for these clients (`bitrix24-reverse:` + `client:<object>:<id>`
 * of each mapping, `client:erp:<id>` of each client) — so a merge and the processing of their contacts never interleave.
 */
export function advisoryKeys(survivorId: number, mergedId: number, mergedRef: string | null, mappings: readonly MappingState[], extraRefs: readonly string[] = []): string[] {
  const keys = new Set<string>();
  for (const ref of [mergedRef, ...extraRefs]) if (ref) keys.add(`client-counterparty:${ref}`);
  for (const m of mappings) if (m.bitrixId) keys.add(`bitrix24-reverse:client:${m.bitrixObject}:${m.bitrixId}`);
  for (const id of [survivorId, mergedId]) keys.add(`bitrix24-reverse:client:erp:${id}`);
  return ['client-merge', ...[...keys].sort()];
}

export async function takeAdvisoryKeys(tx: TransactionClient, keys: readonly string[]): Promise<void> {
  for (const key of keys) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** A fingerprint of everything a preview showed; the command recomputes it under its locks. Not a secret — a state check. */
export function fingerprint(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function pairFingerprint(caseId: number, caseVersion: number, state: PairState): string {
  const client = (c: ClientState) => [c.clientId, c.updatedAt, c.ref, c.contactsVersion, c.isActive, c.merged];
  return fingerprint({
    caseId, caseVersion, survivor: client(state.survivor), merged: client(state.merged),
    projects: state.projects.map((p) => [p.projectId, p.version, p.clientId, p.orderIds]),
    orders: state.orders.map((o) => [o.orderId, o.version, o.projectId, o.clientId]),
    phones: state.phones.map((p) => [p.phoneId, p.clientId, p.number, p.isPrimary, p.ref]),
    contacts: state.contacts.map((c) => [c.contactId, c.clientId, c.kind, c.valueNormalized, c.isPrimary, c.note]),
    mappings: state.mappings.map((m) => [m.clientId, m.bitrixObject, m.bitrixId, m.status]),
    blockers: [state.bitrixRequests, state.whatsappPending, state.groupLinks, state.standaloneDeadlines],
  });
}
