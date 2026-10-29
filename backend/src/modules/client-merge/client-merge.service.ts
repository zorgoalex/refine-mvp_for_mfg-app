import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { OrderAccessPolicy } from '../../permissions/policies/order-access.policy';
import { readableOrderIds } from '../../permissions/policies/order-read-visibility';
import { orderReadVisibilityIsRestricted } from '../../permissions/policies/order-read-scope-sql';
import { recordTransition, type MemberRef } from '../integration-duplicates/duplicate-transitions';
import { ClientCounterpartyRepository } from '../party-contacts/client-counterparty.repository';
import {
  LOCK_ATTEMPTS, MAX_ORDERS, SOURCE, obstacle, type MergeContext, type Obstacle, type ObstacleCode,
} from './client-merge';
import { applyMerge, contactsOverLimit, planContacts, planPhones } from './merge-apply';
import {
  advisoryKeys, pairFingerprint, readBlockers, readClients, readContacts, readMappings, readOrders, readPair, readPhones, readProjects,
  takeAdvisoryKeys, type ClientState, type PairState,
} from './merge-state';
import {
  applyUndo, laterMerges, planUndo, undoSendsPending, readJournal, readMerge, readUndoState, toMerge, undoFingerprint, type JournalItem, type MergeRow, type UndoPlan,
  type UndoSkip, type UndoState,
} from './merge-undo';
import { alignDeadlines, purgeJournals } from './merge-maintenance';

/** A set of rows changed between the locks: the transaction is rolled back and the locks are taken again. */
class LockedSetChanged extends Error {}

interface CaseRow { case_id: string; rule_code: string; entity_kind: string; status: string; version: number }

export interface MergeCommand { survivorId: number; mergedId: number; expectedCaseVersion: number; previewToken: string; idempotencyKey: string }
export interface UndoCommand { previewToken: string; idempotencyKey: string }

const MAINTENANCE_EVERY_MS = 15 * 60_000;
const RETRYABLE = new Set(['40P01', '55P03', '40001']);
/** Below the query timeout of the database service (10 s by default). */
const LOCK_TIMEOUT = '5s';

@Injectable()
export class ClientMergeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientMergeService.name);
  private readonly orders = new OrderAccessPolicy();
  private timer: NodeJS.Timeout | null = null;
  private maintenanceBusy = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ClientCounterpartyRepository) private readonly links: ClientCounterpartyRepository,
  ) {}

  enabled(): boolean {
    return this.config.get('BACKEND_CLIENT_MERGE', { infer: true }) === true;
  }

  private crmEvents(): boolean {
    return this.config.get('BACKEND_CLIENT_MERGE_CRM_EVENTS', { infer: true }) === true;
  }

  onModuleInit(): void {
    // The maintenance runs whatever the flag: copies of the client in deadlines are aligned and personal data of old
    // journals is erased also after the flag went off.
    this.timer = setInterval(() => void this.maintenance(), MAINTENANCE_EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async maintenance(): Promise<void> {
    if (this.maintenanceBusy || !this.database.isConfigured) return;
    this.maintenanceBusy = true;
    try {
      await alignDeadlines(this.database, null);
      await purgeJournals(this.database);
    } catch (error) {
      this.logger.error(`client merge maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.maintenanceBusy = false;
    }
  }

  // ── Merge ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async preview(user: CurrentUser, caseId: number, survivorId: number, mergedId: number) {
    this.requireEnabled();
    const caseRow = await this.readCase(this.database, caseId, false);
    // Only clients of this case: the preview tells nothing about other clients.
    const members = await this.activeClientMembers(this.database, caseId);
    if (!members.includes(survivorId) || !members.includes(mergedId)) {
      throw new ApiError(422, 'NOT_CASE_MEMBERS', 'Клиент не участник этого дела');
    }
    const state = await readPair(this.database, survivorId, mergedId);
    if (!state) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    const obstacles = await this.mergeObstacles(this.database, user, caseRow, state);
    return this.previewView(user, caseRow, state, obstacles);
  }

  async merge(user: CurrentUser, caseId: number, command: MergeCommand, requestId: string) {
    this.requireEnabled();
    if (command.survivorId === command.mergedId) throw new ApiError(422, 'VALIDATION_FAILED', 'Выберите двух разных клиентов');
    const ctx: MergeContext = { requestId, correlationId: requestId };
    const idempotency = { name: 'client.merge', key: command.idempotencyKey, hash: requestHash({ caseId, ...command, idempotencyKey: undefined }) };
    let outcome: { response: Record<string, unknown>; movedOrderIds: number[] } | null = null;
    try {
      outcome = await this.withLockAttempts(() => this.database.transaction(async (tx) => {
        // A held lock fails fast (55P03 → the whole transaction again, then CLIENT_MERGE_BUSY) before the query timeout.
        await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await takeAdvisoryKeys(tx, ['client-merge']);
        const repeat = await this.claimIdempotency(tx, user, idempotency, 'client', command.mergedId);
        if (repeat) return { response: repeat, movedOrderIds: [] };
        const s = command.survivorId;
        const m = command.mergedId;
        // Keys first (1C link, Bitrix reverse), from an unlocked read; the read under the row locks must agree with it.
        const before = await readClients(tx, [s, m], false);
        if (!before.get(s) || !before.get(m)) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
        const mappings = await readMappings(tx, [s, m]);
        await takeAdvisoryKeys(tx, advisoryKeys(s, m, before.get(m)!.ref, mappings).slice(1));
        // Groups → orders → clients → phones/contacts (the order of the group and order commands, of WhatsApp, of the phone commands).
        const projects = await readProjects(tx, m, true);
        const orders = await readOrders(tx, { clientId: m }, true);
        const clients = await readClients(tx, [s, m], true);
        const phones = await readPhones(tx, [s, m], true);
        const contacts = await readContacts(tx, [s, m], true);
        await tx.query(`SELECT 1 FROM party_contact_versions WHERE party_kind = 'client' AND party_id = ANY($1::bigint[]) ORDER BY party_id FOR UPDATE`, [[s, m]]);
        // Rows that arrived between the locks: the merge would miss them — start over (a lock after the client would invert the order).
        const again = {
          projects: await readProjects(tx, m, false), orders: await readOrders(tx, { clientId: m }, false),
          phones: await readPhones(tx, [s, m], false), contacts: await readContacts(tx, [s, m], false), mappings: await readMappings(tx, [s, m]),
        };
        if (!sameRows(projects.map((p) => p.projectId), again.projects.map((p) => p.projectId))
          || !sameRows(orders.map((o) => o.orderId), again.orders.map((o) => o.orderId))
          || !sameRows(phones.map((p) => p.phoneId), again.phones.map((p) => p.phoneId))
          || !sameRows(contacts.map((c) => c.contactId), again.contacts.map((c) => c.contactId))
          || JSON.stringify(mappings) !== JSON.stringify(again.mappings)
          || clients.get(m)?.ref !== before.get(m)?.ref) {
          throw new LockedSetChanged();
        }
        const blockers = await readBlockers(tx, m, orders.map((o) => o.orderId), phones.filter((p) => p.clientId === m).map((p) => p.phoneId));
        const state: PairState = {
          survivor: clients.get(s)!, merged: clients.get(m)!, projects: again.projects, orders, phones, contacts, mappings, ...blockers,
        };
        const caseRow = await this.readCase(tx, caseId, true);
        if (caseRow.version !== command.expectedCaseVersion) {
          throw new ApiError(409, 'DUPLICATE_CASE_CHANGED', 'Дело дубля уже изменилось; обновите страницу', { version: caseRow.version });
        }
        const obstacles = await this.mergeObstacles(tx, user, caseRow, state);
        if (obstacles.length) throw blocked('CLIENT_MERGE_BLOCKED', obstacles);
        if (pairFingerprint(caseId, caseRow.version, state) !== command.previewToken) {
          throw new ApiError(409, 'CLIENT_MERGE_PREVIEW_STALE', 'Данные клиентов изменились после предпросмотра; посмотрите ещё раз');
        }

        const applied = await applyMerge(tx, state, caseId, user, ctx, this.links);
        await this.closeCases(tx, caseRow, m, applied.mergeId, user, ctx);
        await this.recordMerged(tx, state, caseId, applied.mergeId, applied.counts, user, ctx);
        const response = { mergeId: applied.mergeId, caseId, survivorId: s, mergedId: m, counts: applied.counts };
        await completeIdempotency(tx, idempotency.name, user, idempotency.key, response);
        return { response, movedOrderIds: applied.movedOrderIds };
      }));
    } catch (error) {
      await this.denied(user, 'client.merge_denied', error, requestId, { caseId, survivorId: command.survivorId, mergedId: command.mergedId });
      throw error;
    }
    // The clients of deadlines of the moved orders are copies: aligned now, one row per transaction (and by the maintenance).
    await this.alignAfterCommit(outcome.movedOrderIds);
    // The answer (also of a repeat) is built now, by the current rights of the reader: counts of orders it may not see are not given.
    const view = await this.get(user, Number(outcome.response.mergeId));
    return { mergeId: view.mergeId, caseId: view.caseId, survivorId: view.survivor.clientId, mergedId: view.merged.clientId, counts: view.counts };
  }

  private async mergeObstacles(db: DatabaseClient, user: CurrentUser, caseRow: CaseRow, state: PairState): Promise<Obstacle[]> {
    const list: ObstacleCode[] = [];
    if (caseRow.status !== 'open') list.push('CASE_NOT_OPEN');
    const members = await this.activeClientMembers(db, Number(caseRow.case_id));
    if (!members.includes(state.survivor.clientId) || !members.includes(state.merged.clientId)) list.push('NOT_CASE_MEMBERS');
    if (!state.survivor.isActive || !state.merged.isActive) list.push('CLIENT_INACTIVE');
    if (state.survivor.merged || state.merged.merged) list.push('CLIENT_ALREADY_MERGED');
    if (state.survivor.ref && state.merged.ref) list.push('ONEC_LINK_CONFLICT');
    if (state.bitrixRequests > 0) list.push('BITRIX_REQUESTS');
    if (state.whatsappPending > 0) list.push('WHATSAPP_PENDING');
    if (state.groupLinks > 0) list.push('GROUP_LINKS');
    if (state.standaloneDeadlines > 0) list.push('CLIENT_DEADLINES');
    if (contactsOverLimit(planContacts(state))) list.push('CONTACTS_LIMIT');
    if (state.orders.length > MAX_ORDERS) list.push('TOO_MANY_ROWS');
    list.push(...this.permissionObstacles(user, state.orders, state.projects.length > 0));
    return list.map(obstacle);
  }

  /** The rights of every set a merge or an undo changes, by the current rights and owners (not by `clients.merge` alone). */
  private permissionObstacles(user: CurrentUser, orders: ReadonlyArray<{ orderId: number; createdBy: string | null; managerId: string | null }>, projects: boolean): ObstacleCode[] {
    const list: ObstacleCode[] = [];
    // Changing an order needs to see it too (update and read grants are separate).
    if (orders.some((o) => {
      const subject = { orderId: o.orderId, createdByUserId: o.createdBy, managerUserId: o.managerId };
      return !this.orders.canUpdate(user, subject) || !this.orders.canView(user, subject);
    })) list.push('ORDERS_NOT_PERMITTED');
    if (projects && !user.permissions.includes('projects.manage')) list.push('PROJECTS_NOT_PERMITTED');
    if (!user.permissions.includes('clients.update')) list.push('CLIENTS_NOT_PERMITTED');
    return list;
  }

  private async activeClientMembers(db: DatabaseClient, caseId: number): Promise<number[]> {
    return (await db.query<{ id: string }>(
      `SELECT erp_entity_id AS id FROM integration_duplicate_members
        WHERE case_id = $1 AND system = 'erp' AND entity_kind = 'client' AND left_at IS NULL AND erp_entity_id IS NOT NULL`, [caseId])).rows.map((r) => Number(r.id));
  }

  private async readCase(db: DatabaseClient, caseId: number, lock: boolean): Promise<CaseRow> {
    const row = (await db.query<CaseRow>(
      `SELECT case_id, rule_code, entity_kind, status, version FROM integration_duplicate_cases WHERE case_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [caseId])).rows[0];
    if (!row) throw new ApiError(404, 'DUPLICATE_CASE_NOT_FOUND', 'Дело дубля не найдено');
    if (row.entity_kind !== 'client') throw new ApiError(422, 'CLIENT_MERGE_NOT_CLIENTS', 'Объединять можно только клиентов');
    return row;
  }

  /**
   * The merged client leaves every case it stands in. The case of the merge is `merged` when fewer than two members stay
   * (otherwise it stays open for the next step); another case of the merged client below two members is resolved.
   */
  private async closeCases(tx: TransactionClient, mergeCase: CaseRow, mergedId: number, mergeId: number, user: CurrentUser, ctx: MergeContext): Promise<void> {
    const cases = (await tx.query<CaseRow>(
      `SELECT c.case_id, c.rule_code, c.entity_kind, c.status, c.version FROM integration_duplicate_cases c
        WHERE c.case_id = $2 OR EXISTS (SELECT 1 FROM integration_duplicate_members m WHERE m.case_id = c.case_id AND m.system = 'erp'
          AND m.entity_kind = 'client' AND m.erp_entity_id = $1 AND m.left_at IS NULL)
        ORDER BY c.case_id FOR UPDATE OF c`, [mergedId, Number(mergeCase.case_id)])).rows;
    const tctx = { requestId: ctx.requestId, correlationId: ctx.correlationId, actor: user };
    for (const c of cases) {
      const caseId = Number(c.case_id);
      const left = (await tx.query<{ record_key: string }>(
        `UPDATE integration_duplicate_members SET left_at = now()
          WHERE case_id = $1 AND system = 'erp' AND entity_kind = 'client' AND erp_entity_id = $2 AND left_at IS NULL RETURNING record_key`,
        [caseId, mergedId])).rows;
      const remaining = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM integration_duplicate_members WHERE case_id = $1 AND left_at IS NULL', [caseId])).rows[0].n;
      const isMergeCase = caseId === Number(mergeCase.case_id);
      let status = c.status;
      if (remaining < 2 && isMergeCase) status = 'merged';
      else if (remaining < 2 && c.status !== 'resolved' && c.status !== 'merged') status = 'resolved';
      await tx.query(
        `UPDATE integration_duplicate_cases SET status = $2, version = version + 1, updated_at = now(),
                resolved_at = CASE WHEN $2 <> status THEN now() ELSE resolved_at END,
                resolved_by = CASE WHEN $2 <> status THEN $3::bigint ELSE resolved_by END,
                resolution_code = CASE WHEN $2 <> status THEN $4 ELSE resolution_code END,
                resolution_reason = CASE WHEN $2 <> status THEN NULL ELSE resolution_reason END
          WHERE case_id = $1`, [caseId, status, Number(user.id), status === 'merged' ? 'merged' : 'member_merged']);
      const head = { caseId, ruleCode: c.rule_code, entityKind: c.entity_kind, status };
      const member: MemberRef[] = left.map((row) => ({ system: 'erp', entityKind: 'client', recordKey: row.record_key, erpEntityId: mergedId }));
      if (member.length) await recordTransition(tx, head, 'member_left', tctx, member, { reason: 'member_merged', mergeId });
      if (status === 'merged' && c.status !== 'merged') await recordTransition(tx, head, 'merged', tctx, member, { mergeId });
      if (status === 'resolved' && c.status !== 'resolved') await recordTransition(tx, head, 'resolved', tctx, member, { reason: 'member_merged', mergeId });
    }
  }

  private async recordMerged(tx: TransactionClient, state: PairState, caseId: number, mergeId: number, counts: Record<string, number>, user: CurrentUser, ctx: MergeContext) {
    const s = state.survivor.clientId;
    const m = state.merged.clientId;
    await auditService.record(tx, {
      event: 'client.merged', entityType: 'client', entityId: m, actorUserId: Number(user.id), actorUsername: user.username, actorRole: user.role,
      requestId: ctx.requestId, source: SOURCE, relatedClientId: s, statusCode: 'done',
      relatedEntities: [
        { entityType: 'client', entityId: s }, { entityType: 'client', entityId: m }, { entityType: 'client_merge', entityId: mergeId },
        { entityType: 'integration_duplicate_case', entityId: caseId },
        ...state.orders.map((o) => ({ entityType: 'order', entityId: o.orderId })),
        ...state.projects.map((p) => ({ entityType: 'project', entityId: p.projectId })),
      ],
      before: { mergedClientActive: true }, after: { mergedClientActive: false, survivorId: s },
      metadata: { mergeId, caseId, counts, correlationId: ctx.correlationId },
    });
    await this.announce(tx, 'client.merged', mergeId, { mergeId, caseId, survivorId: s, mergedId: m, counts, actorUserId: Number(user.id), requestId: ctx.requestId, correlationId: ctx.correlationId });
    if (this.crmEvents()) {
      await tx.query(
        `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('crm.sync.client.merged', 'crm_sync', $1, $2::jsonb, $3)`,
        [String(m), JSON.stringify({ mergeId, mergedClientId: m, survivorId: s }), `client.merged:${mergeId}`]);
    }
  }

  private async announce(tx: TransactionClient, eventType: 'client.merged' | 'client.merge_undone', mergeId: number, payload: Record<string, unknown>) {
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ($1, 'client_merge', $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`,
      [eventType, String(mergeId), JSON.stringify({ eventType, ...payload, source: SOURCE }), `${eventType}:${mergeId}`]);
  }

  private async previewView(user: CurrentUser, caseRow: CaseRow, state: PairState, obstacles: Obstacle[]) {
    const visible = await visibleOrders(this.database, user, state.orders.map((o) => o.orderId));
    const shown = state.orders.filter((o) => visible === null || visible.has(o.orderId));
    const phones = planPhones(state);
    const contacts = planContacts(state);
    const fullPhones = user.permissions.includes('clients.view');
    const phone = (number: string) => (fullPhones ? number : maskPhone(number));
    const warnings: string[] = [];
    if (state.survivor.personType !== state.merged.personType) warnings.push('PERSON_TYPE_DIFFERS');
    if (state.merged.notes) warnings.push('MERGED_NOTES_STAY');
    if (state.mappings.some((mp) => mp.clientId === state.merged.clientId && mp.status === 'active')) warnings.push('BITRIX_CONTACT_STAYS');
    if (phones.drop.some((d) => d.keyLost)) warnings.push('PHONE_ONEC_KEY_LOST');
    return {
      caseId: Number(caseRow.case_id), caseVersion: caseRow.version,
      survivor: clientView(state.survivor), merged: clientView(state.merged),
      moves: {
        // Only what the reader may see: counts of hidden orders (and of groups with them) are not given.
        projects: state.projects.filter((p) => p.orderIds.every((id) => visible === null || visible.has(id))).length, orders: shown.length,
        ordersShown: shown.map((o) => ({ orderId: o.orderId, name: o.name, deleted: o.deleted })),
        ordersHidden: state.orders.length - shown.length > 0,
        onecLink: state.merged.ref !== null,
      },
      phones: {
        moved: phones.move.map((p) => ({ phoneId: p.phoneId, number: phone(p.number) })),
        dropped: phones.drop.map((d) => ({ phoneId: d.phone.phoneId, number: phone(d.phone.number), sameAsPhoneId: d.match.phoneId, onecKeyLost: d.keyLost })),
        primaryPhoneId: phones.primary?.phoneId ?? null,
      },
      contacts: {
        moved: contacts.move.map((c) => ({ contactId: c.contactId, kind: c.kind, value: fullPhones ? c.value : '•••' })),
        dropped: contacts.drop.map((d) => ({ contactId: d.contact.contactId, kind: d.contact.kind, value: fullPhones ? d.contact.value : '•••' })),
        total: contacts.total,
      },
      warnings,
      obstacles,
      previewToken: pairFingerprint(Number(caseRow.case_id), caseRow.version, state),
    };
  }

  // ── Undo ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async undoPreview(user: CurrentUser, mergeId: number) {
    const merge = await readMerge(this.database, mergeId, false);
    if (!merge) throw new ApiError(404, 'CLIENT_MERGE_NOT_FOUND', 'Объединение не найдено');
    const items = await readJournal(this.database, mergeId);
    const state = await readUndoState(this.database, merge, items, false);
    const plan = planUndo(merge, items, state);
    const obstacles = await this.undoObstacles(this.database, user, merge, state, plan);
    const seen = await this.orderSight(user, items);
    const visible = await visibleOrders(this.database, user, plan.orderIds);
    return {
      merge: await this.mergeView(user, merge, items),
      returns: {
        projects: plan.projects.filter((p) => p.orderIds.every((id) => visible === null || visible.has(id))).length,
        orders: plan.orderIds.filter((id) => visible === null || visible.has(id)).length,
        ordersShown: plan.orderIds.filter((id) => visible === null || visible.has(id)),
        phones: plan.phonesBack.length + plan.phonesRestore.length, contacts: plan.contactsBack.length + plan.contactsRestore.length,
        onecLink: plan.onecLink !== null,
      },
      skipped: seen.skipped(plan.skipped),
      obstacles,
      previewToken: merge.status === 'done' ? undoFingerprint(merge, state) : null,
    };
  }

  async undo(user: CurrentUser, mergeId: number, command: UndoCommand, requestId: string) {
    const ctx: MergeContext = { requestId, correlationId: requestId };
    const idempotency = { name: 'client.merge_undo', key: command.idempotencyKey, hash: requestHash({ mergeId, previewToken: command.previewToken }) };
    let outcome: { response: Record<string, unknown>; orderIds: number[] } | null = null;
    try {
      outcome = await this.withLockAttempts(() => this.database.transaction(async (tx) => {
        // A held lock fails fast (55P03 → the whole transaction again, then CLIENT_MERGE_BUSY) before the query timeout.
        await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await takeAdvisoryKeys(tx, ['client-merge']);
        const repeat = await this.claimIdempotency(tx, user, idempotency, 'client_merge', mergeId);
        if (repeat) return { response: repeat, orderIds: [] };
        const merge = await readMerge(tx, mergeId, true);
        if (!merge) throw new ApiError(404, 'CLIENT_MERGE_NOT_FOUND', 'Объединение не найдено');
        if (merge.status === 'undone') throw new ApiError(409, 'CLIENT_MERGE_ALREADY_UNDONE', 'Объединение уже отменено');
        if (merge.expired || merge.purged) throw new ApiError(410, 'CLIENT_MERGE_UNDO_EXPIRED', 'Срок отмены объединения истёк');
        const items = await readJournal(tx, mergeId);
        const aliases = [merge.mergedId, ...items.filter((i) => i.kind === 'redirect_repointed').map((i) => i.rowId)];
        const refs = await readClients(tx, [merge.survivorId, merge.mergedId], false);
        const mappings = await readMappings(tx, [merge.survivorId, ...aliases]);
        const linkRef = items.find((i) => i.kind === 'onec_link')?.after?.refKey1c as string | undefined;
        await takeAdvisoryKeys(tx, advisoryKeys(merge.survivorId, merge.mergedId, null, mappings,
          [linkRef ?? '', refs.get(merge.survivorId)?.ref ?? ''].filter(Boolean)).slice(1));
        const locked = await readUndoState(tx, merge, items, true);
        const again = await readUndoState(tx, merge, items, false);
        if (undoFingerprint(merge, locked) !== undoFingerprint(merge, again) || JSON.stringify(mappings) !== JSON.stringify(await readMappings(tx, [merge.survivorId, ...aliases]))) {
          throw new LockedSetChanged();
        }
        const plan = planUndo(merge, items, again);
        const obstacles = await this.undoObstacles(tx, user, merge, again, plan);
        if (obstacles.length) throw blocked('CLIENT_MERGE_UNDO_BLOCKED', obstacles);
        if (undoFingerprint(merge, again) !== command.previewToken) {
          throw new ApiError(409, 'CLIENT_MERGE_UNDO_STALE', 'Данные клиентов изменились после предпросмотра отмены; посмотрите ещё раз');
        }
        const report = await applyUndo(tx, merge, items, plan, user, ctx, this.links);
        await this.reopenCase(tx, merge, user, ctx);
        await auditService.record(tx, {
          event: 'client.merge_undone', entityType: 'client', entityId: merge.mergedId, actorUserId: Number(user.id), actorUsername: user.username,
          actorRole: user.role, requestId, source: SOURCE, relatedClientId: merge.survivorId, statusCode: 'undone',
          relatedEntities: [
            { entityType: 'client', entityId: merge.survivorId }, { entityType: 'client', entityId: merge.mergedId },
            { entityType: 'client_merge', entityId: mergeId }, { entityType: 'integration_duplicate_case', entityId: merge.caseId },
            ...plan.orderIds.map((id) => ({ entityType: 'order', entityId: id })), ...plan.projects.map((p) => ({ entityType: 'project', entityId: p.projectId })),
          ],
          before: { mergedClientActive: false }, after: { mergedClientActive: true },
          metadata: { mergeId, caseId: merge.caseId, report, correlationId: ctx.correlationId },
        });
        await this.announce(tx, 'client.merge_undone', mergeId, {
          mergeId, caseId: merge.caseId, survivorId: merge.survivorId, mergedId: merge.mergedId, returned: report.returned, skipped: report.skipped.length,
          actorUserId: Number(user.id), requestId, correlationId: ctx.correlationId,
        });
        if (this.crmEvents()) {
          await tx.query(
            `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
             VALUES ('crm.sync.client.merge_undone', 'crm_sync', $1, $2::jsonb, $3)`,
            [String(merge.mergedId), JSON.stringify({ mergeId, mergedClientId: merge.mergedId, survivorId: merge.survivorId }), `client.merge_undone:${mergeId}`]);
        }
        const response = { mergeId, status: 'undone' };
        await completeIdempotency(tx, idempotency.name, user, idempotency.key, response);
        return { response, orderIds: plan.orderIds };
      }));
    } catch (error) {
      await this.denied(user, 'client.merge_undo_denied', error, requestId, { mergeId });
      throw error;
    }
    await this.alignAfterCommit(outcome.orderIds);
    const view = await this.get(user, mergeId);
    return { mergeId, status: view.status, report: view.undoReport };
  }

  private async undoObstacles(db: DatabaseClient, user: CurrentUser, merge: MergeRow, state: UndoState, plan: UndoPlan): Promise<Obstacle[]> {
    if (merge.status !== 'done' || merge.expired || merge.purged) return [];
    const list: ObstacleCode[] = [];
    if (await laterMerges(db, merge) > 0) list.push('UNDO_ORDER');
    const link = plan.skipped.find((x) => x.kind === 'onec_link');
    if (link) list.push(state.refs.get(merge.mergedId) ? 'UNDO_MERGED_LINKED' : 'UNDO_ONEC_LINK_CONFLICT');
    if (state.aliasRequests > 0) list.push('BITRIX_ALIAS_REQUESTS');
    if (undoSendsPending(state, plan)) list.push('WHATSAPP_PENDING');
    const back = state.orders.filter((o) => plan.orderIds.includes(o.orderId));
    list.push(...this.permissionObstacles(user, back, plan.projects.length > 0));
    return list.map(obstacle);
  }

  private async reopenCase(tx: TransactionClient, merge: MergeRow, user: CurrentUser, ctx: MergeContext): Promise<void> {
    const row = (await tx.query<CaseRow>('SELECT case_id, rule_code, entity_kind, status, version FROM integration_duplicate_cases WHERE case_id = $1 FOR UPDATE',
      [merge.caseId])).rows[0];
    if (!row) return;
    const back = (await tx.query<{ record_key: string }>(
      `UPDATE integration_duplicate_members SET left_at = NULL
        WHERE case_id = $1 AND system = 'erp' AND entity_kind = 'client' AND erp_entity_id = $2 AND left_at IS NOT NULL RETURNING record_key`,
      [merge.caseId, merge.mergedId])).rows;
    await tx.query(
      `UPDATE integration_duplicate_cases SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution_code = NULL, resolution_reason = NULL,
              version = version + 1, updated_at = now() WHERE case_id = $1`, [merge.caseId]);
    await recordTransition(tx, { caseId: merge.caseId, ruleCode: row.rule_code, entityKind: row.entity_kind, status: 'open' }, 'merge_undone',
      { requestId: ctx.requestId, correlationId: ctx.correlationId, actor: user },
      back.map((b) => ({ system: 'erp', entityKind: 'client', recordKey: b.record_key, erpEntityId: merge.mergedId })), { mergeId: merge.mergeId, previousStatus: row.status });
  }

  // ── History ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  async history(user: CurrentUser, clientId: number) {
    const rows = (await this.database.query<Record<string, unknown>>(
      `SELECT m.merge_id, m.case_id, m.survivor_id, m.merged_id, m.status, m.actor_user_id, ua.username::text AS actor_name,
              m.merged_at::text AS merged_at, m.undo_until::text AS undo_until, m.undone_at::text AS undone_at, m.undone_by,
              uu.username::text AS undone_by_name, m.counts, m.undo_report, m.journal_purged_at IS NOT NULL AS purged, m.undo_until <= now() AS expired
         FROM client_merges m LEFT JOIN users ua ON ua.user_id = m.actor_user_id LEFT JOIN users uu ON uu.user_id = m.undone_by
        WHERE m.survivor_id = $1 OR m.merged_id = $1 ORDER BY m.merged_at DESC, m.merge_id DESC LIMIT 100`, [clientId])).rows;
    const redirect = (await this.database.query<{ survivor_id: string; client_name: string }>(
      `SELECT r.survivor_id, c.client_name::text AS client_name FROM client_merge_redirects r JOIN clients c ON c.client_id = r.survivor_id
        WHERE r.merged_client_id = $1`, [clientId])).rows[0];
    return {
      clientId,
      mergedInto: redirect ? { clientId: Number(redirect.survivor_id), name: redirect.client_name } : null,
      merges: await Promise.all(rows.map((r) => this.mergeView(user, toMerge(r)))),
    };
  }

  async get(user: CurrentUser, mergeId: number) {
    const merge = await readMerge(this.database, mergeId, false);
    if (!merge) throw new ApiError(404, 'CLIENT_MERGE_NOT_FOUND', 'Объединение не найдено');
    return this.mergeView(user, merge);
  }

  /**
   * What of the orders and groups of a merge the reader may see: counts and skipped rows of orders outside the reader's
   * order visibility are not given (not even as a number); a group counts only with all its orders visible.
   */
  private async orderSight(user: CurrentUser, items: readonly JournalItem[]) {
    const orderIds = items.filter((i) => i.kind === 'order').map((i) => i.rowId);
    const visible = orderReadVisibilityIsRestricted(user) || !user.permissions.includes('orders.view') ? await visibleOrders(this.database, user, orderIds) : null;
    const seesOrder = (id: number) => visible === null || visible.has(id);
    const projectOrders = new Map(items.filter((i) => i.kind === 'project').map((i) => [i.rowId, ((i.after?.orderIds as number[] | undefined) ?? []).map(Number)]));
    const seesProject = (id: number) => (projectOrders.get(id) ?? []).every(seesOrder);
    return {
      restricted: visible !== null, seesOrder, seesProject,
      orders: orderIds.filter(seesOrder).length,
      projects: [...projectOrders.keys()].filter(seesProject).length,
      skipped: (skips: readonly UndoSkip[]) => skips.filter((x) => (x.kind === 'order' ? seesOrder(x.rowId) : x.kind === 'project' ? seesProject(x.rowId) : true)),
    };
  }

  private async mergeView(user: CurrentUser, merge: MergeRow, journal?: readonly JournalItem[]) {
    const names = await readClients(this.database, [merge.survivorId, merge.mergedId], false);
    const seen = await this.orderSight(user, journal ?? await readJournal(this.database, merge.mergeId));
    const counts = seen.restricted ? { ...merge.counts, orders: seen.orders, projects: seen.projects } : merge.counts;
    const report = merge.undoReport;
    const undoReport = report === null ? null : {
      returned: seen.restricted
        ? { ...report.returned, orders: (report.orderIds ?? []).filter(seen.seesOrder).length, projects: (report.projectIds ?? []).filter(seen.seesProject).length }
        : report.returned,
      skipped: seen.skipped(report.skipped),
    };
    return {
      mergeId: merge.mergeId, caseId: merge.caseId, status: merge.status,
      survivor: { clientId: merge.survivorId, name: names.get(merge.survivorId)?.name ?? null },
      merged: { clientId: merge.mergedId, name: names.get(merge.mergedId)?.name ?? null },
      mergedAt: merge.mergedAt, mergedBy: { userId: merge.actorUserId, username: merge.actorName },
      undoUntil: merge.undoUntil, undoneAt: merge.undoneAt, undoneBy: merge.undoneBy === null ? null : { userId: merge.undoneBy, username: merge.undoneByName },
      counts, undoReport,
      canUndo: merge.status === 'done' && !merge.expired && !merge.purged && user.permissions.includes('clients.merge'),
    };
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private requireEnabled(): void {
    if (!this.enabled()) throw new ApiError(404, 'CLIENT_MERGE_DISABLED', 'Объединение клиентов выключено');
  }

  private async withLockAttempts<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const retry = error instanceof LockedSetChanged || (typeof code === 'string' && RETRYABLE.has(code));
        if (!retry) throw error;
        if (attempt >= LOCK_ATTEMPTS) throw new ApiError(409, 'CLIENT_MERGE_BUSY', 'Клиентов сейчас изменяют; повторите через минуту');
      }
    }
  }

  /** The command key of a user: a repeat returns the first answer; the same key with another body is refused. */
  private async claimIdempotency(tx: TransactionClient, user: CurrentUser, idem: { name: string; key: string; hash: string }, entityType: string, entityId: number) {
    const key = commandKey(idem.name, user, idem.key);
    const inserted = (await tx.query(
      `INSERT INTO command_idempotency_keys (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing') ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [key, idem.name, Number(user.id), entityType, String(entityId), idem.hash])).rows.length > 0;
    if (inserted) return null;
    const row = (await tx.query<{ request_hash: string; response_json: Record<string, unknown> | null; status: string }>(
      'SELECT request_hash, response_json, status FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE', [key])).rows[0];
    if (!row || row.request_hash !== idem.hash) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован для другого запроса');
    if (row.status !== 'completed' || !row.response_json) throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Команда ещё выполняется');
    return row.response_json;
  }

  private async alignAfterCommit(orderIds: number[]): Promise<void> {
    if (!orderIds.length) return;
    try {
      await alignDeadlines(this.database, orderIds);
    } catch (error) {
      this.logger.warn(`deadlines of merged orders not aligned now (maintenance will): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A refused merge or undo leaves a durable audit row after the rollback (the command transaction kept nothing). */
  private async denied(user: CurrentUser, event: string, error: unknown, requestId: string, refs: { caseId?: number; survivorId?: number; mergedId?: number; mergeId?: number }) {
    if (!(error instanceof ApiError) || error.statusCode >= 500) return;
    try {
      await auditService.recordDenied(this.database, {
        event, entityType: refs.mergeId ? 'client_merge' : 'client', entityId: refs.mergeId ?? refs.mergedId ?? 0,
        actorUserId: Number(user.id), actorUsername: user.username, actorRole: user.role, requestId, source: SOURCE,
        relatedClientId: refs.survivorId ?? null, reason: error.code,
        relatedEntities: [
          ...(refs.survivorId ? [{ entityType: 'client', entityId: refs.survivorId }] : []),
          ...(refs.mergedId ? [{ entityType: 'client', entityId: refs.mergedId }] : []),
          ...(refs.caseId ? [{ entityType: 'integration_duplicate_case', entityId: refs.caseId }] : []),
          ...(refs.mergeId ? [{ entityType: 'client_merge', entityId: refs.mergeId }] : []),
        ],
        metadata: {
          ...refs, correlationId: requestId,
          obstacles: Array.isArray(error.details?.obstacles) ? (error.details!.obstacles as Obstacle[]).map((o) => o.code) : undefined,
        },
      });
    } catch (auditError) {
      this.logger.error(`denied audit of ${event} not written: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
    }
  }
}

/** The orders of `ids` the reader may see (null — all): none without `orders.view`, else by the order read visibility. */
async function visibleOrders(db: DatabaseClient, user: CurrentUser, ids: readonly number[]): Promise<Set<number> | null> {
  if (!user.permissions.includes('orders.view')) return new Set();
  return readableOrderIds(db, user, ids);
}

function blocked(code: string, obstacles: Obstacle[]): ApiError {
  return new ApiError(409, code, obstacles.map((o) => o.message).join('; '), { obstacles });
}

const commandKey = (name: string, user: CurrentUser, key: string) => `${name}:${user.id}:${key}`;

async function completeIdempotency(tx: TransactionClient, name: string, user: CurrentUser, key: string, response: Record<string, unknown>): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys SET status = 'completed', response_json = $2::jsonb, completed_at = now() WHERE idempotency_key = $1`,
    [commandKey(name, user, key), JSON.stringify(response)]);
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameRows(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function clientView(c: ClientState) {
  return {
    clientId: c.clientId, name: c.name, personType: c.personType, isActive: c.isActive, notes: c.notes, onecLinked: c.ref !== null,
    createdAt: c.createdAt, createdBy: c.createdBy === null ? null : { userId: c.createdBy, username: c.createdByName },
  };
}

function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.length >= 2 ? `+7 *** *** ** ${digits.slice(-2)}` : '***';
}
