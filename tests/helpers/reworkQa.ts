import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Isolated «Переделка» browser QA (ORDER_REWORK_QA=true): a copy of the stage DB with its own backend,
 * Hasura and Vite dev server. Never points at the shared stage stack.
 */
export const qaEnabled = process.env.ORDER_REWORK_QA === 'true';
export const frontendUrl = process.env.ORDER_REWORK_QA_FRONTEND_URL ?? 'http://localhost:5199';
export const qaDatabase = process.env.ORDER_REWORK_QA_DB ?? 'rework_qa';
const postgresContainer = process.env.ORDER_REWORK_QA_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';

export const PREFIX = 'E2E-Тест переделка QA';

export function psql(sql: string): string {
  if (qaDatabase === 'erpdb') throw new Error('ORDER_REWORK_QA_DB must not be the shared stage database');
  return execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'erp_user', '-d', qaDatabase, '-v', 'ON_ERROR_STOP=1', '-qAt'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

export const q = (value: string) => value.replace(/'/g, "''");

export function runId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(4, 14);
}

export function createUser(username: string, roleId: number): { userId: number; password: string } {
  const password = crypto.randomBytes(18).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);
  const userId = Number(psql(`
    INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
    VALUES ('${q(username)}', '${q(username)}@example.invalid', '${q(hash)}', ${roleId}, '${q(`${PREFIX} ${username}`)}', true)
    RETURNING user_id;`));
  return { userId, password };
}

export interface Fixture { orderId: number; orderName: string; detailIds: number[] }

/** An order with N details on one stage, written like the integration fixtures (backend stage-event writer). */
export function createOrder(input: {
  name: string; createdBy: number; orderStatus: string; detailStage: string; details?: number; clientName?: string;
  /** «Переделка» 1.1: the order's planned/completion dates (YYYY-MM-DD); the order date is a month earlier. */
  plannedDate?: string; completionDate?: string;
}): Fixture {
  const count = input.details ?? 3;
  const out = psql(`
    BEGIN;
    SELECT set_config('erp.pse_writer', 'backend', true);
    WITH c AS (
      INSERT INTO clients (client_name, created_by) VALUES ('${q(input.clientName ?? `${PREFIX} клиент ${input.name}`)}', ${input.createdBy})
      RETURNING client_id
    ), p AS (
      INSERT INTO projects (code, name, client_id, created_by)
      SELECT 'E2E-RQA-' || substr(md5('${q(input.name)}'), 1, 10), '${q(`${PREFIX} группа ${input.name}`)}', c.client_id, ${input.createdBy}
      FROM c RETURNING project_id
    ), o AS (
      INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, manager_id,
                          order_date, planned_completion_date, completion_date)
      SELECT '${q(input.name)}', c.client_id, p.project_id,
             (SELECT order_status_id FROM order_statuses WHERE order_status_code = '${q(input.orderStatus)}'),
             (SELECT min(payment_status_id) FROM payment_statuses), ${input.createdBy}, ${input.createdBy},
             current_date - 30, ${input.plannedDate ? `'${input.plannedDate}'::date` : 'NULL'},
             ${input.completionDate ? `'${input.completionDate}'::date` : 'NULL'}
      FROM c, p RETURNING order_id
    ), d AS (
      INSERT INTO order_details
        (order_id, detail_number, detail_name, height, width, area, milling_type_id, edge_type_id, created_by,
         sheet_material_type_id, production_status_id)
      SELECT o.order_id, n, 'Фасад ' || n, 700 + n, 400, 0.28, (SELECT min(milling_type_id) FROM milling_types),
             (SELECT min(edge_type_id) FROM edge_types), ${input.createdBy},
             (SELECT min(sheet_material_type_id) FROM sheet_material_types),
             (SELECT production_status_id FROM production_statuses WHERE production_status_code = '${q(input.detailStage)}')
      FROM o, generate_series(1, ${count}) n
      RETURNING detail_id, production_status_id
    ), e AS (
      INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no)
      SELECT detail_id, production_status_id, '{}'::jsonb, 1 FROM d
    )
    SELECT (SELECT order_id FROM o) || ':' || (SELECT string_agg(detail_id::text, ',' ORDER BY detail_id) FROM d);
    COMMIT;`);
  const line = out.split('\n').find((l) => /^\d+:/.test(l)) ?? '';
  const [orderId, details] = line.split(':');
  return { orderId: Number(orderId), orderName: input.name, detailIds: details.split(',').map(Number) };
}

export function orderState(orderId: number): { status: string; round: number; lastRound: number } {
  const [status, round, lastRound] = psql(`
    SELECT s.order_status_code, o.production_round, o.last_round_no
    FROM orders o JOIN order_statuses s USING (order_status_id) WHERE o.order_id = ${orderId};`).split('|');
  return { status, round: Number(round), lastRound: Number(lastRound) };
}

export function detailStates(orderId: number): Array<{ n: number; stage: string; round: number }> {
  return psql(`
    SELECT d.detail_number, ps.production_status_code, d.production_round FROM order_details d
    JOIN production_statuses ps USING (production_status_id) WHERE d.order_id = ${orderId} ORDER BY d.detail_number;`)
    .split('\n').filter(Boolean).map((row) => {
      const [n, stage, round] = row.split('|');
      return { n: Number(n), stage, round: Number(round) };
    });
}

export function rounds(orderId: number): Array<{ round: number; closed: boolean; closeReason: string | null; reason: string; mode: string }> {
  return psql(`
    SELECT r.round_no, r.closed_at IS NOT NULL, coalesce(r.close_reason, ''), rr.code, r.mode
    FROM order_production_rounds r JOIN order_rework_reasons rr ON rr.order_rework_reason_id = r.reason_id
    WHERE r.order_id = ${orderId} ORDER BY r.round_no;`)
    .split('\n').filter(Boolean).map((row) => {
      const [round, closed, closeReason, reason, mode] = row.split('|');
      return { round: Number(round), closed: closed === 't', closeReason: closeReason || null, reason, mode };
    });
}

/** «Переделка» 1.1: the order dates. */
export function orderDates(orderId: number): { planned: string | null; completion: string | null } {
  const [planned, completion] = psql(`SELECT coalesce(planned_completion_date::text, ''), coalesce(completion_date::text, '')
    FROM orders WHERE order_id = ${orderId};`).split('|');
  return { planned: planned || null, completion: completion || null };
}

/** The round's deadline fields. */
export function roundDeadline(orderId: number, roundNo: number): { planned: string | null; source: string | null; fromPlanned: string | null; mark: boolean } {
  const [planned, source, fromPlanned, mark] = psql(`SELECT coalesce(planned_completion_date::text, ''), coalesce(planned_completion_source, ''),
    coalesce(from_planned_completion_date::text, ''), deadline_sync_requested_at IS NOT NULL
    FROM order_production_rounds WHERE order_id = ${orderId} AND round_no = ${roundNo};`).split('|');
  return { planned: planned || null, source: source || null, fromPlanned: fromPlanned || null, mark: mark === 't' };
}

/** Final-deadline instances of the order: status, date (UTC day) and round tag. */
export function finalDeadlines(orderId: number): Array<{ status: string; at: string; round: number | null }> {
  return psql(`SELECT status, (deadline_at AT TIME ZONE 'UTC')::date, coalesce(metadata_json->>'reworkRoundNo', '')
    FROM deadline_instances WHERE entity_type = 'order' AND entity_id = '${orderId}' ORDER BY created_at, deadline_id;`)
    .split('\n').filter(Boolean).map((row) => {
      const [status, at, round] = row.split('|');
      return { status, at, round: round ? Number(round) : null };
    });
}

/** «Схема этапов и сроки»: the stored state (to restore) and a fill — every active stage `days`, reserve `reserve`. */
export function saveSchedule(): { durations: string; reserve: string } {
  return {
    durations: psql(`SELECT coalesce(json_agg(d)::text, '[]') FROM deadline_default_stage_durations d;`),
    reserve: psql('SELECT reserve_days FROM deadline_default_schedule_config WHERE config_id = 1;'),
  };
}

export function fillSchedule(days: number, reserve: number): void {
  psql(`BEGIN; DELETE FROM deadline_default_stage_durations;
    INSERT INTO deadline_default_stage_durations (production_status_id, position, duration_days, parallel_with_previous)
    SELECT production_status_id, row_number() OVER (ORDER BY sort_order, production_status_id), ${days}, false
      FROM production_statuses WHERE is_active = true;
    UPDATE deadline_default_schedule_config SET reserve_days = ${reserve} WHERE config_id = 1; COMMIT;`);
}

export function restoreSchedule(saved: { durations: string; reserve: string }): void {
  psql(`BEGIN; DELETE FROM deadline_default_stage_durations;
    INSERT INTO deadline_default_stage_durations (production_status_id, position, duration_days, parallel_with_previous)
    SELECT production_status_id, position, duration_days, parallel_with_previous
      FROM json_populate_recordset(NULL::deadline_default_stage_durations, '${q(saved.durations)}'::json);
    UPDATE deadline_default_schedule_config SET reserve_days = ${Number(saved.reserve)} WHERE config_id = 1; COMMIT;`);
}

/** Every QA fixture goes away: orders (cascade), clients, users, the audit/outbox they produced. */
export function cleanup(): void {
  psql(`
    BEGIN;
    CREATE TEMP TABLE qa_orders AS SELECT order_id FROM orders WHERE order_name LIKE '${q(PREFIX)}%';
    CREATE TEMP TABLE qa_users AS SELECT user_id FROM users WHERE full_name LIKE '${q(PREFIX)}%';
    DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE related_order_id IN (SELECT order_id FROM qa_orders));
    DELETE FROM audit_log WHERE related_order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id IN (SELECT order_id::text FROM qa_orders);
    DELETE FROM command_idempotency_keys WHERE entity_type = 'order' AND entity_id IN (SELECT order_id::text FROM qa_orders);
    DELETE FROM realtime_event_log WHERE order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM audit_log WHERE entity_type = 'deadline' AND related_order_id IN (SELECT order_id FROM qa_orders);
    SET LOCAL session_replication_role = replica;
    DELETE FROM mdf_board_history_state WHERE order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM mdf_board_history_coverage WHERE order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM mdf_board_history_events WHERE order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM production_status_events WHERE order_id IN (SELECT order_id FROM qa_orders)
       OR detail_id IN (SELECT detail_id FROM order_details WHERE order_id IN (SELECT order_id FROM qa_orders));
    DELETE FROM production_stage_mark_history WHERE order_id IN (SELECT order_id FROM qa_orders);
    SET LOCAL session_replication_role = origin;
    DELETE FROM orders WHERE order_id IN (SELECT order_id FROM qa_orders);
    DELETE FROM projects WHERE name LIKE '${q(PREFIX)}%';
    DELETE FROM clients WHERE client_name LIKE '${q(PREFIX)}%';
    DELETE FROM order_rework_reasons WHERE name LIKE '${q(PREFIX)}%';
    DELETE FROM user_preferences WHERE user_id IN (SELECT user_id FROM qa_users);
    DELETE FROM audit_log WHERE user_id IN (SELECT user_id FROM qa_users);
    DELETE FROM users WHERE user_id IN (SELECT user_id FROM qa_users);
    COMMIT;`);
}

export function residue(): string {
  return psql(`SELECT (SELECT count(*) FROM orders WHERE order_name LIKE '${q(PREFIX)}%') || '/' ||
                      (SELECT count(*) FROM users WHERE full_name LIKE '${q(PREFIX)}%') || '/' ||
                      (SELECT count(*) FROM clients WHERE client_name LIKE '${q(PREFIX)}%');`);
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  const response = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Войти' }).click();
  // The app rotates the refresh token right after login; navigating away mid-request would lose it.
  const rotated = page.waitForResponse((r) => r.url().includes('/api/v1/auth/refresh') && r.request().method() === 'POST', { timeout: 30000 });
  expect((await response).status()).toBeLessThan(300);
  expect((await rotated).status()).toBeLessThan(300);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

export async function openOrder(page: Page, orderId: number): Promise<void> {
  await page.goto(`${frontendUrl}/orders/show/${orderId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Круги производства').or(page.getByRole('button', { name: /переделк/i })).first())
    .toBeVisible({ timeout: 45000 }).catch(() => undefined);
}
