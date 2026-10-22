import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import { KEY_VERSION, caseKeyHash, caseKeyMask } from './duplicate-keys';
import { DUPLICATE_RULES, type DuplicateRule, type RuleEnv } from './duplicate-rules';
import { recordTransition, type CaseHead, type MemberRef, type TransitionContext } from './duplicate-transitions';
import { recordId, type CheckContext, type DuplicateEntityKind, type DuplicateSystem, type RecordRef } from './integration-duplicates';

interface RuleRow {
  system: DuplicateSystem;
  entity_kind: DuplicateEntityKind;
  record_key: string;
  erp_entity_id: string | null;
  key: string;
  personal: boolean;
  dep_source: string | null;
  dep_entity: string | null;
  dep_snapshot: Date | null;
  created_at: Date | null;
  author: string | null;
  via: string | null;
}

interface CaseRow {
  case_id: string;
  rule_code: string;
  entity_kind: string;
  status: string;
  key_mask: string | null;
  decision_status: 'dismissed' | 'external' | null;
  decision_by: string | null;
  decision_reason: string | null;
}

interface MemberRow {
  system: DuplicateSystem;
  entity_kind: DuplicateEntityKind;
  record_key: string;
  erp_entity_id: string | null;
  left_at: Date | null;
}

export interface ClaimedRecord {
  ref: RecordRef;
  requestIds: number[];
  via: CheckContext['via'];
  authorUserId: number | null;
  correlationId: string | null;
}

export interface Claim {
  leaseId: string;
  records: ClaimedRecord[];
}

export type SourceState = 'current' | 'replaced' | 'revoked' | 'expired' | 'missing';

const LEASE_MINUTES = 5;
const CLAIM_LIMIT = 500;
const VIAS = new Set(['erp_manual', 'bitrix_inbound', 'onec_publication', 'catalog_import', 'order_import', 'scan']);

const ref = (row: { system: DuplicateSystem; entity_kind: DuplicateEntityKind; record_key: string }): RecordRef =>
  ({ system: row.system, entityKind: row.entity_kind, recordKey: row.record_key });
const memberRef = (row: { system: DuplicateSystem; entity_kind: DuplicateEntityKind; record_key: string; erp_entity_id: string | null }): MemberRef =>
  ({ ...ref(row), erpEntityId: row.erp_entity_id === null ? null : Number(row.erp_entity_id) });
const head = (row: CaseRow): CaseHead => ({ caseId: Number(row.case_id), ruleCode: row.rule_code, entityKind: row.entity_kind, status: row.status });

/**
 * Finds duplicates and keeps the cases in step with the data: a check of one record (queued by the triggers of the
 * directories and by publications of 1C), a full pass of rules, and the cleanup of keys read from 1C sets that were
 * revoked or outlived the personal data term. Every case changes in its own transaction under its row lock; reads of
 * the directories take no locks.
 */
@Injectable()
export class DuplicateEngineRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  private secret(): string {
    const secret = this.config.get('BACKEND_INTEGRATION_DUPLICATES_KEY', { infer: true });
    if (!secret) throw new Error('BACKEND_INTEGRATION_DUPLICATES_KEY is not set');
    return secret;
  }

  hasSecret(): boolean {
    return Boolean(this.config.get('BACKEND_INTEGRATION_DUPLICATES_KEY', { infer: true }));
  }

  hash(rule: DuplicateRule, key: string): Buffer {
    return caseKeyHash(this.secret(), rule.code, key);
  }

  /**
   * The secret is the one the keys of the cases were made with (set on first use). Another secret is refused: its keys
   * would not find the old cases (they would be created again and lose the decisions of users).
   */
  async ensureKey(): Promise<void> {
    const fingerprint = caseKeyHash(this.secret(), 'integration-duplicates', 'key-fingerprint');
    await this.database.query('UPDATE integration_duplicate_settings SET key_fingerprint = $1, updated_at = now() WHERE id AND key_fingerprint IS NULL', [fingerprint]);
    const row = (await this.database.query<{ key_fingerprint: Buffer | null }>('SELECT key_fingerprint FROM integration_duplicate_settings WHERE id')).rows[0];
    if (!row?.key_fingerprint || !row.key_fingerprint.equals(fingerprint)) {
      throw Object.assign(new Error('the duplicates key secret differs from the one the cases were made with'), { code: 'DUPLICATES_KEY_MISMATCH' });
    }
  }

  async ruleEnv(client: DatabaseClient = this.database): Promise<RuleEnv & { trigram: boolean }> {
    const row = (await client.query<{ onec: boolean; trigram: boolean }>(
      `SELECT to_regclass('onec_etl_mirror_rows') IS NOT NULL AND to_regclass('onec_etl_entity_state') IS NOT NULL AS onec,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trigram`)).rows[0];
    return { onec: row.onec, trigram: row.trigram };
  }

  runnable(rule: DuplicateRule, env: RuleEnv & { trigram: boolean }): boolean {
    // A rule reading 1C leaves its 1C part out (or yields nothing) without the 1C tables.
    return !rule.needsTrigram || env.trigram;
  }

  /** Rows of a rule: all of them, the keys of one record, or the records of some keys. */
  async runRule(rule: DuplicateRule, env: RuleEnv, filter: { record?: RecordRef; keys?: string[] } = {}, client: DatabaseClient = this.database): Promise<RuleRow[]> {
    const sql = rule.sql(env);
    if (filter.record) {
      return (await client.query<RuleRow>(`SELECT * FROM (${sql}) r WHERE r.system = $1 AND r.entity_kind = $2 AND r.record_key = $3`,
        [filter.record.system, filter.record.entityKind, filter.record.recordKey])).rows;
    }
    if (filter.keys) return (await client.query<RuleRow>(`SELECT * FROM (${sql}) r WHERE r.key = ANY($1::text[])`, [filter.keys])).rows;
    return (await client.query<RuleRow>(`SELECT * FROM (${sql}) r WHERE r.key IS NOT NULL`)).rows;
  }

  /** Re-evaluates every rule a record takes part in: its current keys and the cases it is a member of. */
  async checkRecord(record: RecordRef, check: CheckContext): Promise<number> {
    const env = await this.ruleEnv();
    let changed = 0;
    for (const rule of DUPLICATE_RULES) {
      if (!rule.kinds.includes(record.entityKind) || !this.runnable(rule, env)) continue;
      const keys = [...new Set((await this.runRule(rule, env, { record })).map((row) => row.key))];
      const hashes = new Set<string>();
      for (const key of keys) {
        const hash = this.hash(rule, key);
        hashes.add(hash.toString('hex'));
        if (await this.syncGroup(rule, env, hash, key, check, record)) changed += 1;
      }
      // Cases this record is in whose key it no longer has: the case is re-evaluated by its other members.
      const stale = (await this.database.query<{ case_id: string; key_hash: Buffer }>(
        `SELECT c.case_id, c.key_hash FROM integration_duplicate_members m JOIN integration_duplicate_cases c ON c.case_id = m.case_id
          WHERE m.system = $1 AND m.entity_kind = $2 AND m.record_key = $3 AND m.left_at IS NULL AND c.rule_code = $4
            AND c.key_version = $5 AND c.key_hash IS NOT NULL`,
        [record.system, record.entityKind, record.recordKey, rule.code, KEY_VERSION])).rows.filter((row) => !hashes.has(row.key_hash.toString('hex')));
      for (const row of stale) {
        if (await this.syncGroup(rule, env, row.key_hash, null, check, null)) changed += 1;
      }
    }
    return changed;
  }

  /** A full pass of some rules: every group of two or more records is a case; a case without its group is re-evaluated. */
  async fullPass(rules: readonly DuplicateRule[], check: CheckContext): Promise<{ changed: number; failed: number; lastError: string | null }> {
    const env = await this.ruleEnv();
    let changed = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const rule of rules) {
      if (!this.runnable(rule, env)) continue;
      const byHash = new Map<string, { key: string; rows: RuleRow[] }>();
      for (const row of await this.runRule(rule, env)) {
        const hash = this.hash(rule, row.key).toString('hex');
        const group = byHash.get(hash) ?? { key: row.key, rows: [] };
        group.rows.push(row);
        byHash.set(hash, group);
      }
      const keep = async (task: () => Promise<boolean>) => {
        try { if (await task()) changed += 1; } catch (error) { failed += 1; lastError = errorCode(error); }
      };
      for (const [hash, group] of byHash) {
        if (distinctMembers(group.rows) < 2) continue;
        await keep(() => this.syncGroup(rule, env, Buffer.from(hash, 'hex'), group.key, check, null));
      }
      const live = (await this.database.query<{ key_hash: Buffer }>(
        `SELECT key_hash FROM integration_duplicate_cases WHERE rule_code = $1 AND key_version = $2 AND key_hash IS NOT NULL AND status <> 'resolved'`,
        [rule.code, KEY_VERSION])).rows;
      for (const row of live) {
        const group = byHash.get(row.key_hash.toString('hex'));
        if (group && distinctMembers(group.rows) >= 2) continue;
        await keep(() => this.syncGroup(rule, env, row.key_hash, group?.key ?? null, check, null));
      }
    }
    return { changed, failed, lastError };
  }

  /**
   * Brings the case of one key in step with the records that have it now. Creates it for a group of two or more;
   * members join, leave and come back; a case below two members is resolved; a resolved case found again — or a
   * dismissed one joined by a record it never had — opens again. Returns whether anything visible changed.
   *
   * Everything is read inside the transaction, after an advisory lock of the key: two checkers of one key (the queue
   * and a full pass) apply one after the other, each with the data committed before it. `key` null — only the hash is
   * known (a case whose record changed): the key is found again through an active member, or everybody leaves. A case
   * whose 1C data was revoked or expired is purged here too, before its dependencies could be replaced.
   */
  async syncGroup(rule: DuplicateRule, env: RuleEnv, hash: Buffer, knownKey: string | null, check: CheckContext, focus: RecordRef | null): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`integration-duplicate:${rule.code}:${hash.toString('hex')}`]);
      const found = await lockCase(tx, rule.code, hash);
      // The states of the 1C sets with revocation stay as read until the commit (a revocation or a new snapshot waits).
      if (env.onec && rule.readsOnec) await lockOnecStates(tx);
      if (found) {
        const bad = (await tx.query<{ state: SourceState }>(
          `SELECT onec_entity_snapshot_state(source_id, entity_code, snapshot_version) AS state FROM integration_duplicate_case_sources WHERE case_id = $1`,
          [found.case_id])).rows.map((row) => row.state).filter((state) => state === 'revoked' || state === 'expired' || state === 'missing');
        if (bad.length) return purgeInTx(tx, found, bad.every((state) => state === 'expired') ? 'source_expired' : 'source_revoked', check);
      }
      let key = knownKey;
      if (key === null && found) key = await this.keyOfMembers(tx, rule, env, Number(found.case_id), hash);
      const rows = key === null ? [] : await this.runRule(rule, env, { keys: [key] }, tx);
      return this.applyGroup(tx, rule, hash, key, rows, check, focus, found);
    });
  }

  /** The key of a case through one of its active members (the case keeps only the hash). */
  private async keyOfMembers(tx: TransactionClient, rule: DuplicateRule, env: RuleEnv, caseId: number, hash: Buffer): Promise<string | null> {
    const members = (await tx.query<MemberRow>(
      'SELECT system, entity_kind, record_key, erp_entity_id, left_at FROM integration_duplicate_members WHERE case_id = $1 AND left_at IS NULL', [caseId])).rows;
    for (const member of members) {
      for (const row of await this.runRule(rule, env, { record: ref(member) }, tx)) {
        if (this.hash(rule, row.key).equals(hash)) return row.key;
      }
    }
    return null;
  }

  private async applyGroup(
    tx: TransactionClient, rule: DuplicateRule, hash: Buffer, key: string | null, rows: readonly RuleRow[], check: CheckContext,
    focus: RecordRef | null, locked: CaseRow | undefined,
  ): Promise<boolean> {
    const current = new Map<string, RuleRow>();
    for (const row of rows) if (!current.has(recordId(ref(row)))) current.set(recordId(ref(row)), row);
    const deps = new Map<string, { sourceId: number; entity: string; snapshot: Date }>();
    for (const row of rows) {
      if (row.dep_source === null || row.dep_entity === null || row.dep_snapshot === null) continue;
      const id = `${row.dep_source}:${row.dep_entity}`;
      const known = deps.get(id);
      if (!known || known.snapshot < row.dep_snapshot) deps.set(id, { sourceId: Number(row.dep_source), entity: row.dep_entity, snapshot: row.dep_snapshot });
    }
    const personal = rows.some((row) => row.personal);
    const ctx: TransitionContext = { requestId: check.requestId, correlationId: check.correlationId, actor: null };
    {
      let found = locked;
      let created = false;
      if (!found) {
        if (current.size < 2 || key === null) return false;
        const inserted = (await tx.query<CaseRow>(
          `INSERT INTO integration_duplicate_cases (rule_code, entity_kind, key_version, key_hash, key_mask, strength, detected_via, detected_correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING
           RETURNING case_id, rule_code, entity_kind, status, key_mask, decision_status, decision_by, decision_reason`,
          [rule.code, rule.entityKind, KEY_VERSION, hash, caseKeyMask(rule.maskKind, key, personal), rule.strength, check.via, check.correlationId])).rows[0];
        found = inserted ?? await lockCase(tx, rule.code, hash);
        if (!found) return false;
        created = Boolean(inserted);
      }
      const caseId = Number(found.case_id);
      const existing = new Map((await tx.query<MemberRow>(
        'SELECT system, entity_kind, record_key, erp_entity_id, left_at FROM integration_duplicate_members WHERE case_id = $1', [caseId])).rows
        .map((row) => [recordId(ref(row)), row]));

      const joined: RuleRow[] = [];
      let newcomers = 0;
      for (const [id, row] of current) {
        const was = existing.get(id);
        if (was && was.left_at === null) continue;
        if (!was) newcomers += 1;
        const isFocus = focus !== null && recordId(focus) === id;
        const via = isFocus && check.via !== 'scan' ? check.via : VIAS.has(row.via ?? '') ? row.via : 'unknown';
        const author = row.author !== null ? Number(row.author) : isFocus ? check.authorUserId : null;
        await tx.query(
          `INSERT INTO integration_duplicate_members (case_id, system, entity_kind, record_key, erp_entity_id, record_created_at, record_author_user_id, record_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (case_id, system, entity_kind, record_key) DO UPDATE SET left_at = NULL, joined_at = now()`,
          [caseId, row.system, row.entity_kind, row.record_key, row.erp_entity_id, row.created_at, author, via]);
        joined.push(row);
      }
      const left = [...existing.entries()].filter(([id, row]) => row.left_at === null && !current.has(id)).map(([, row]) => row);
      for (const row of left) {
        await tx.query('UPDATE integration_duplicate_members SET left_at = now() WHERE case_id = $1 AND system = $2 AND entity_kind = $3 AND record_key = $4',
          [caseId, row.system, row.entity_kind, row.record_key]);
      }
      const active = current.size;
      let status = found.status;
      let reopened: string | null = null;
      let restored = false;
      // A case closed by a merge of its clients stays merged (a terminal state, as resolved); a new record opens it again.
      if (active < 2 && status !== 'resolved' && status !== 'merged') status = 'resolved';
      else if (active >= 2 && newcomers > 0 && status !== 'open') { status = 'open'; reopened = 'new_member'; }
      else if (active >= 2 && status === 'resolved') {
        // The same members matching again: the decision of the user comes back; without one the case opens again.
        if (found.decision_status) { status = found.decision_status; restored = true; } else { status = 'open'; reopened = 'matched_again'; }
      }

      // The 1C dependencies describe the key only while the group stands: a case left with fewer than two members keeps
      // the ones it had, so revocation and the personal data term still reach its key and mask.
      const depsChanged = active >= 2 ? await replaceSources(tx, caseId, [...deps.values()]) : false;
      // Without rows nothing says whether a member is a person: the stored (already safe) mask stays.
      const mask = key === null || rows.length === 0 ? found.key_mask : caseKeyMask(rule.maskKind, key, personal);
      const visible = created || joined.length > 0 || left.length > 0 || status !== found.status;
      await tx.query(
        `UPDATE integration_duplicate_cases SET status = $2, key_mask = COALESCE($3, key_mask), last_seen_at = CASE WHEN $4 THEN now() ELSE last_seen_at END,
                resolved_at = CASE WHEN $2 = 'resolved' AND status <> 'resolved' THEN now() WHEN $6 THEN now() WHEN $2 <> 'resolved' AND $2 <> status THEN NULL ELSE resolved_at END,
                resolved_by = CASE WHEN $6 THEN decision_by WHEN $2 <> status THEN NULL ELSE resolved_by END,
                resolution_code = CASE WHEN $2 = 'resolved' AND status <> 'resolved' THEN 'no_match'
                                       WHEN $6 THEN CASE decision_status WHEN 'dismissed' THEN 'not_duplicate' ELSE 'fix_in_onec' END
                                       WHEN $2 <> status THEN NULL ELSE resolution_code END,
                resolution_reason = CASE WHEN $6 THEN decision_reason WHEN $2 <> status THEN NULL ELSE resolution_reason END,
                -- A record the case never had makes the decision void (even while the case stands below two members): the
                -- users decided about another set of records.
                decision_status = CASE WHEN $7 THEN NULL ELSE decision_status END,
                decision_by = CASE WHEN $7 THEN NULL ELSE decision_by END,
                decision_reason = CASE WHEN $7 THEN NULL ELSE decision_reason END,
                version = version + CASE WHEN $5 THEN 1 ELSE 0 END, updated_at = now()
          WHERE case_id = $1`, [caseId, status, mask, active >= 2, visible, restored, newcomers > 0]);

      const caseHead = head({ ...found, status });
      const all = [...current.values()].map(memberRef);
      if (created) {
        await recordTransition(tx, caseHead, 'detected', ctx, all, { via: check.via, strength: rule.strength });
      } else {
        for (const row of joined) await recordTransition(tx, caseHead, 'member_joined', ctx, [memberRef(row)], { via: check.via });
        for (const row of left) await recordTransition(tx, caseHead, 'member_left', ctx, [memberRef(row)], {});
        if (reopened) await recordTransition(tx, caseHead, 'reopened', ctx, all, { reason: reopened });
        if (restored) {
          await recordTransition(tx, caseHead, found.decision_status === 'dismissed' ? 'dismissed' : 'marked_external', ctx, all,
            { reason: 'decision_restored', decisionReason: found.decision_reason });
        }
        if (status === 'resolved' && found.status !== 'resolved') await recordTransition(tx, caseHead, 'resolved', ctx, all, { reason: 'no_match' });
        if (!visible && depsChanged) await recordTransition(tx, caseHead, 'source_refreshed', ctx, [], {});
      }
      return visible;
    }
  }

  /** States of the 1C sets the keys of cases were read from. */
  async sourceStates(): Promise<Array<{ caseId: number; state: SourceState }>> {
    return (await this.database.query<{ case_id: string; state: SourceState }>(
      `SELECT cs.case_id, onec_entity_snapshot_state(cs.source_id, cs.entity_code, cs.snapshot_version) AS state
         FROM integration_duplicate_case_sources cs JOIN integration_duplicate_cases c ON c.case_id = cs.case_id
        WHERE c.key_hash IS NOT NULL`)).rows.map((row) => ({ caseId: Number(row.case_id), state: row.state }));
  }

  /**
   * A key read from a revoked set, a set with no state, or a snapshot older than the personal data term is removed:
   * the case keeps its history but loses its key and mask, members of 1C are deleted, and it is resolved.
   */
  /** Purges a case if — read again under its locks — one of its 1C dependencies is revoked, missing or expired. */
  async purgeCase(caseId: number, check: CheckContext): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      // The same key lock as a check of the case: a purge and a check never interleave.
      const keyed = (await tx.query<{ rule_code: string; key_hash: Buffer }>(
        'SELECT rule_code, key_hash FROM integration_duplicate_cases WHERE case_id = $1 AND key_hash IS NOT NULL', [caseId])).rows[0];
      if (!keyed) return false;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`integration-duplicate:${keyed.rule_code}:${keyed.key_hash.toString('hex')}`]);
      const found = (await tx.query<CaseRow>(
        `SELECT case_id, rule_code, entity_kind, status, key_mask, decision_status, decision_by, decision_reason FROM integration_duplicate_cases WHERE case_id = $1 AND key_hash = $2 FOR UPDATE`,
        [caseId, keyed.key_hash])).rows[0];
      if (!found) return false;
      if ((await tx.query<{ ok: boolean }>(`SELECT to_regclass('onec_etl_entity_state') IS NOT NULL AS ok`)).rows[0]?.ok) await lockOnecStates(tx);
      const bad = (await tx.query<{ state: SourceState }>(
        `SELECT onec_entity_snapshot_state(source_id, entity_code, snapshot_version) AS state FROM integration_duplicate_case_sources WHERE case_id = $1`,
        [caseId])).rows.map((row) => row.state).filter((state) => state === 'revoked' || state === 'expired' || state === 'missing');
      if (!bad.length) return false;
      return purgeInTx(tx, found, bad.every((state) => state === 'expired') ? 'source_expired' : 'source_revoked', check);
    });
  }

  /** A case whose 1C set got a new snapshot: its members are checked again (unless a check is already waiting). */
  async requeueMembers(caseId: number, correlationId: string): Promise<number> {
    return (await this.database.query(
      `INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via, correlation_id)
       SELECT m.entity_kind, m.system, m.record_key, 'onec_publication', $2 FROM integration_duplicate_members m
        WHERE m.case_id = $1 AND m.left_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM integration_duplicate_check_requests r WHERE r.entity_kind = m.entity_kind AND r.system = m.system
                                                                               AND r.record_key = m.record_key AND r.lease_id IS NULL)`,
      [caseId, correlationId])).rowCount ?? 0;
  }

  async enqueue(entityKind: DuplicateEntityKind, system: DuplicateSystem, recordKey: string, via: CheckContext['via'], correlationId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO integration_duplicate_check_requests (entity_kind, system, record_key, via, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
      [entityKind, system, recordKey, via, correlationId]);
  }

  /**
   * Takes free committed requests with a lease, in a short transaction of its own (a trigger appending a request never
   * waits for it). Requests of one record are taken together; their exact ids are kept for the acknowledgement.
   */
  async claim(): Promise<Claim> {
    const leaseId = randomUUID();
    const rows = (await this.database.query<{ request_id: string; entity_kind: DuplicateEntityKind; system: DuplicateSystem; record_key: string; via: string;
      author_user_id: string | null; correlation_id: string | null }>(
      `UPDATE integration_duplicate_check_requests r SET lease_id = $1, leased_until = now() + make_interval(mins => $2)
        WHERE r.request_id IN (SELECT request_id FROM integration_duplicate_check_requests
                                WHERE leased_until IS NULL OR leased_until < now() ORDER BY request_id LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING r.request_id, r.entity_kind, r.system, r.record_key, r.via, r.author_user_id, r.correlation_id`,
      [leaseId, LEASE_MINUTES, CLAIM_LIMIT])).rows.sort((a, b) => Number(a.request_id) - Number(b.request_id));
    const records = new Map<string, ClaimedRecord>();
    for (const row of rows) {
      const record = ref(row);
      const id = recordId(record);
      const entry = records.get(id) ?? { ref: record, requestIds: [], via: 'scan', authorUserId: null, correlationId: null };
      entry.requestIds.push(Number(row.request_id));
      // The latest write names how the record came and who touched it.
      if (VIAS.has(row.via)) entry.via = row.via as CheckContext['via'];
      if (row.author_user_id !== null) entry.authorUserId = Number(row.author_user_id);
      if (row.correlation_id !== null) entry.correlationId = row.correlation_id;
      records.set(id, entry);
    }
    return { leaseId, records: [...records.values()] };
  }

  /** Done: only the requests taken by this lease go (a request appended meanwhile stays for the next round). */
  async acknowledge(leaseId: string, requestIds: readonly number[], record: RecordRef): Promise<void> {
    await this.database.query('DELETE FROM integration_duplicate_check_requests WHERE request_id = ANY($1::bigint[]) AND lease_id = $2', [requestIds, leaseId]);
    await this.database.query('DELETE FROM integration_duplicate_check_failures WHERE entity_kind = $1 AND system = $2 AND record_key = $3',
      [record.entityKind, record.system, record.recordKey]);
  }

  /** Failed: the requests come back later (attempts × 1 minute, at most an hour); the error is kept as a code. */
  async release(leaseId: string, requestIds: readonly number[], record: RecordRef, code: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const attempts = Number((await tx.query<{ attempts: number }>(
        `INSERT INTO integration_duplicate_check_failures (entity_kind, system, record_key, attempts, last_error_code, retry_at)
         VALUES ($1, $2, $3, 1, $4, now() + interval '1 minute')
         ON CONFLICT (entity_kind, system, record_key) DO UPDATE SET attempts = integration_duplicate_check_failures.attempts + 1,
           last_error_code = EXCLUDED.last_error_code, updated_at = now(),
           retry_at = now() + make_interval(mins => LEAST(60, integration_duplicate_check_failures.attempts + 1))
         RETURNING attempts`, [record.entityKind, record.system, record.recordKey, code.slice(0, 200)])).rows[0].attempts);
      await tx.query(
        `UPDATE integration_duplicate_check_requests SET lease_id = NULL, leased_until = now() + make_interval(mins => $3)
          WHERE request_id = ANY($1::bigint[]) AND lease_id = $2`, [requestIds, leaseId, Math.min(60, attempts)]);
    });
  }

  /** With the search off nothing takes the requests: old free ones go (the first full pass after it is on covers them). */
  async dropStaleRequests(): Promise<number> {
    return (await this.database.query(
      `DELETE FROM integration_duplicate_check_requests WHERE lease_id IS NULL AND created_at < now() - interval '7 days'`)).rowCount ?? 0;
  }

  async installed(): Promise<boolean> {
    return (await this.database.query<{ ok: boolean }>(`SELECT to_regclass('integration_duplicate_cases') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  }
}

/** Removes the key, the mask and the members of 1C of a case whose 1C data was revoked or expired; resolves it. */
async function purgeInTx(tx: TransactionClient, found: CaseRow, reason: 'source_revoked' | 'source_expired', check: CheckContext): Promise<boolean> {
  const caseId = Number(found.case_id);
  const members = (await tx.query<MemberRow>(
    'SELECT system, entity_kind, record_key, erp_entity_id, left_at FROM integration_duplicate_members WHERE case_id = $1 AND left_at IS NULL', [caseId])).rows;
  await tx.query(`DELETE FROM integration_duplicate_members WHERE case_id = $1 AND system = 'onec'`, [caseId]);
  await tx.query('UPDATE integration_duplicate_members SET left_at = now() WHERE case_id = $1 AND left_at IS NULL', [caseId]);
  await tx.query('DELETE FROM integration_duplicate_case_sources WHERE case_id = $1', [caseId]);
  await tx.query(
    `UPDATE integration_duplicate_cases SET key_hash = NULL, key_mask = NULL, status = 'resolved', resolution_code = $2,
            resolved_at = now(), resolved_by = NULL, version = version + 1, updated_at = now() WHERE case_id = $1`, [caseId, reason]);
  await recordTransition(tx, head({ ...found, status: 'resolved' }), 'resolved', { requestId: check.requestId, correlationId: check.correlationId, actor: null },
    members.filter((m) => m.system !== 'onec').map(memberRef), { reason });
  return true;
}

/**
 * Share-locks the state rows of the 1C sets with revocation (by source, set) — the K4a technique: the 1C module takes a
 * state row FOR UPDATE to revoke it or to publish a snapshot and holds nothing of ours, so the order cannot deadlock.
 */
async function lockOnecStates(tx: TransactionClient): Promise<void> {
  await tx.query(`SELECT 1 FROM onec_etl_entity_state WHERE entity_code IN ('counterparty_phones', 'counterparty_contacts')
                   ORDER BY source_id, entity_code FOR SHARE`);
}

async function lockCase(tx: TransactionClient, ruleCode: string, hash: Buffer): Promise<CaseRow | undefined> {
  return (await tx.query<CaseRow>(
    `SELECT case_id, rule_code, entity_kind, status, key_mask, decision_status, decision_by, decision_reason FROM integration_duplicate_cases
      WHERE rule_code = $1 AND key_version = $2 AND key_hash = $3 FOR UPDATE`, [ruleCode, KEY_VERSION, hash])).rows[0];
}

/** Replaces the 1C dependencies of a case; true when they changed. */
async function replaceSources(tx: TransactionClient, caseId: number, deps: ReadonlyArray<{ sourceId: number; entity: string; snapshot: Date }>): Promise<boolean> {
  const before = (await tx.query<{ source_id: string; entity_code: string; snapshot_version: Date }>(
    'SELECT source_id, entity_code, snapshot_version FROM integration_duplicate_case_sources WHERE case_id = $1', [caseId])).rows;
  const fingerprint = (items: Array<[string, string, number]>) => items.map((x) => x.join('|')).sort().join(',');
  const was = fingerprint(before.map((row) => [row.source_id, row.entity_code, row.snapshot_version.getTime()]));
  const now = fingerprint(deps.map((dep) => [String(dep.sourceId), dep.entity, dep.snapshot.getTime()]));
  if (was === now) return false;
  await tx.query('DELETE FROM integration_duplicate_case_sources WHERE case_id = $1', [caseId]);
  for (const dep of deps) {
    await tx.query('INSERT INTO integration_duplicate_case_sources (case_id, source_id, entity_code, snapshot_version) VALUES ($1, $2, $3, $4)',
      [caseId, dep.sourceId, dep.entity, dep.snapshot]);
  }
  return true;
}

function distinctMembers(rows: readonly RuleRow[]): number {
  return new Set(rows.map((row) => recordId(ref(row)))).size;
}

export function errorCode(error: unknown): string {
  const record = error as { code?: unknown; name?: unknown } | null;
  if (record && typeof record.code === 'string') return record.code;
  return error instanceof Error ? error.name : 'unknown';
}
