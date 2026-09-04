import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { AuditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { calculatePaymentStatusId, roundMoney } from '../../orders/domain/order-calculations';
import { USER_ROLES, type UserRole } from '../../../permissions/permissions';

export type WidgetCommandStatus =
  | 'processing'
  | 'pre_create_saved'
  | 'remote_create_started'
  | 'remote_create_ambiguous'
  | 'remote_created'
  | 'snapshot_saved'
  | 'awaiting_order'
  | 'awaiting_order_ready'
  | 'awaiting_erp_retry'
  | 'awaiting_overpayment_confirmation'
  | 'awaiting_actor_reauth'
  | 'completed'
  | 'confirmed_not_created'
  | 'failed_terminal';

export interface ActiveWidgetInstallation {
  memberId: string;
  domain: string;
  applicationTokenHash: string;
  executorBitrixUserId: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  accessTokenExpiresAt: Date;
}

export interface WidgetInstallAttempt {
  attemptId: string;
  memberId: string;
  domain: string;
  applicationTokenHash: string;
  executorBitrixUserId: string;
  expiresAt: Date;
}

export interface WidgetSession {
  sessionId: string;
  memberId: string;
  domain: string;
  dealId: string;
  bitrixUserId: string;
  erpUserId: number;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  accessTokenExpiresAt: Date;
}

export interface WidgetMappedUser {
  userId: number;
  username: string;
  fullName: string | null;
  roleId: number;
  roleCode: UserRole;
}

export interface WidgetDealContext {
  dealId: string;
  requestId: number | null;
  requestState: string | null;
  orderId: number | null;
  orderKind: string | null;
  orderVersion: number | null;
  finalAmount: string | null;
  paidAmount: string | null;
  managerId: number | null;
  createdBy: number | null;
  hasActiveDetails: boolean;
}

export interface WidgetPaymentSystem {
  paySystemId: number;
  name: string;
  typePaidId: number;
  isDefault: boolean;
}

export interface ManualPaymentCommand {
  commandId: string;
  idempotencyKey: string;
  requestHash: string;
  memberId: string;
  domain: string;
  bitrixDealId: string;
  bitrixActorUserId: string;
  erpActorUserId: number;
  bitrixExecutorUserId: string;
  originatingRequestId: string;
  requestId: number | null;
  erpOrderId: number | null;
  expectedOrderVersion: number | null;
  bitrixPaymentId: string | null;
  erpPaymentId: number | null;
  amount: string;
  currencyId: string;
  paymentDate: string;
  paySystemId: number;
  typePaidId: number;
  comment: string | null;
  overpaymentConfirmed: boolean;
  beforePaymentIds: string[];
  diagnosticCandidateIds: string[];
  status: WidgetCommandStatus;
  version: number;
  callerAccessTokenCiphertext: string | null;
  callerRefreshTokenCiphertext: string | null;
  callerAccessTokenExpiresAt: Date | null;
  response: Record<string, unknown> | null;
  errorCode: string | null;
}

interface InstallationRow extends QueryResultRow {
  member_id: string;
  domain: string;
  application_token_hash: string;
  executor_bitrix_user_id: string | null;
  executor_is_admin: boolean;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: Date | string;
}

interface SessionRow extends QueryResultRow {
  session_id: string;
  member_id: string;
  domain: string;
  bitrix_deal_id: string;
  bitrix_user_id: string;
  erp_user_id: string | number;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  command_id: string;
  idempotency_key: string;
  request_hash: string;
  member_id: string;
  domain: string;
  bitrix_deal_id: string;
  bitrix_actor_user_id: string;
  erp_actor_user_id: string | number;
  bitrix_executor_user_id: string;
  originating_request_id: string;
  request_id: string | number | null;
  erp_order_id: string | number | null;
  expected_order_version: string | number | null;
  bitrix_payment_id: string | null;
  erp_payment_id: string | number | null;
  amount: string | number;
  currency_id: string;
  payment_date: Date | string;
  pay_system_id: string | number;
  type_paid_id: string | number;
  comment: string | null;
  overpayment_confirmed: boolean;
  before_payment_ids: unknown;
  diagnostic_candidate_ids: unknown;
  status: WidgetCommandStatus;
  version: string | number;
  caller_access_token_ciphertext: string | null;
  caller_refresh_token_ciphertext: string | null;
  caller_access_token_expires_at: Date | string | null;
  response_json: Record<string, unknown> | null;
  error_code: string | null;
}

export class Bitrix24PaymentWidgetRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async getActiveInstallation(
    memberId: string,
    domain: string,
  ): Promise<ActiveWidgetInstallation | null> {
    const result = await this.db.query<InstallationRow>(
      `SELECT member_id, domain, application_token_hash,
              executor_bitrix_user_id, executor_is_admin,
              access_token_ciphertext, refresh_token_ciphertext,
              access_token_expires_at
         FROM bitrix24_app_installation
        WHERE member_id=$1 AND domain=$2 AND status='active'`,
      [memberId, domain],
    );
    const row = result.rows[0];
    if (!row || !row.executor_is_admin || !row.executor_bitrix_user_id) return null;
    return {
      memberId: row.member_id,
      domain: row.domain,
      applicationTokenHash: row.application_token_hash,
      executorBitrixUserId: row.executor_bitrix_user_id,
      accessTokenCiphertext: row.access_token_ciphertext,
      refreshTokenCiphertext: row.refresh_token_ciphertext,
      accessTokenExpiresAt: new Date(row.access_token_expires_at),
    };
  }

  async saveInstallAttempt(input: {
    stateTokenHash: string;
    memberId: string;
    domain: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    accessTokenExpiresAt: Date;
    applicationTokenHash: string;
    executorBitrixUserId: string;
  }): Promise<WidgetInstallAttempt> {
    const result = await this.db.query<{
      attempt_id: string;
      member_id: string;
      domain: string;
      application_token_hash: string;
      executor_bitrix_user_id: string;
      expires_at: Date | string;
    }>(
      `INSERT INTO bitrix24_app_install_attempt (
         state_token_hash, member_id, domain, access_token_ciphertext,
         refresh_token_ciphertext, access_token_expires_at,
         application_token_hash, executor_bitrix_user_id, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 minutes')
       ON CONFLICT (state_token_hash) DO UPDATE SET updated_at=now()
       RETURNING attempt_id, member_id, domain, application_token_hash,
                 executor_bitrix_user_id, expires_at`,
      [
        input.stateTokenHash,
        input.memberId,
        input.domain,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.accessTokenExpiresAt,
        input.applicationTokenHash,
        input.executorBitrixUserId,
      ],
    );
    return mapInstallAttempt(result.rows[0]);
  }

  async getInstallAttempt(stateTokenHash: string): Promise<WidgetInstallAttempt | null> {
    const result = await this.db.query<{
      attempt_id: string;
      member_id: string;
      domain: string;
      application_token_hash: string;
      executor_bitrix_user_id: string;
      expires_at: Date | string;
    }>(
      `UPDATE bitrix24_app_install_attempt
          SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE status END,
              updated_at=now()
        WHERE state_token_hash=$1
        RETURNING attempt_id, member_id, domain, application_token_hash,
                  executor_bitrix_user_id, expires_at, status`,
      [stateTokenHash],
    );
    const row = result.rows[0];
    return row && new Date(row.expires_at).getTime() > Date.now()
      ? mapInstallAttempt(row)
      : null;
  }

  async promoteInstallAttempt(input: {
    stateTokenHash: string;
    memberId: string;
    domain: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    accessTokenExpiresAt: Date;
    applicationTokenHash: string;
    executorBitrixUserId: string;
    requestId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const attempt = await tx.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM bitrix24_app_install_attempt
          WHERE state_token_hash=$1 AND member_id=$2 AND domain=$3
            AND executor_bitrix_user_id=$4
            AND application_token_hash=$5
            AND status='installing' AND expires_at>now()
          FOR UPDATE`,
        [
          input.stateTokenHash,
          input.memberId,
          input.domain,
          input.executorBitrixUserId,
          input.applicationTokenHash,
        ],
      );
      if (!attempt.rows[0]) {
        throw new ApiError(
          409,
          'BITRIX24_INSTALL_ATTEMPT_INVALID',
          'Bitrix24 installation attempt is absent or expired',
        );
      }
      await tx.query(
        `INSERT INTO bitrix24_app_installation (
           member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
           access_token_expires_at, application_token_hash, status,
           executor_bitrix_user_id, executor_is_admin,
           installed_at, refreshed_at, refresh_next_attempt_at,
           last_error, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,true,now(),NULL,now(),NULL,now())
         ON CONFLICT (member_id) DO UPDATE SET
           domain=EXCLUDED.domain,
           access_token_ciphertext=EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
           access_token_expires_at=EXCLUDED.access_token_expires_at,
           application_token_hash=EXCLUDED.application_token_hash,
           executor_bitrix_user_id=EXCLUDED.executor_bitrix_user_id,
           executor_is_admin=true, status='active', last_error=NULL,
           refresh_next_attempt_at=now(), updated_at=now()`,
        [
          input.memberId,
          input.domain,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          input.accessTokenExpiresAt,
          input.applicationTokenHash,
          input.executorBitrixUserId,
        ],
      );
      await tx.query(
        `UPDATE bitrix24_app_install_attempt
            SET status='promoted', promoted_at=now(), updated_at=now()
          WHERE attempt_id=$1`,
        [attempt.rows[0].attempt_id],
      );
      await this.audit.record(tx, {
        event: 'bitrix24.widget.installation_promoted',
        entityType: 'bitrix24_app_installation',
        entityId: input.memberId,
        requestId: input.requestId,
        source: 'bitrix24-widget-install',
        after: {
          domain: input.domain,
          status: 'active',
          executorBitrixUserId: input.executorBitrixUserId,
        },
      });
    });
  }

  async findMappedUser(bitrixUserId: string): Promise<WidgetMappedUser | null> {
    const result = await this.db.query<{
      user_id: string | number;
      username: string;
      full_name: string | null;
      role_id: string | number;
      role_code: UserRole;
    }>(
      `SELECT target.user_id, target.username, target.full_name, target.role_id,
              role.role_code
         FROM bitrix24_user_mapping mapping
         JOIN users target ON target.user_id=mapping.erp_user_id
         JOIN roles role ON role.role_id=target.role_id AND role.is_active=true
        WHERE mapping.bitrix_user_id=$1
          AND mapping.is_active=true
          AND target.is_active=true
          AND target.is_service_account=false
        LIMIT 1`,
      [bitrixUserId],
    );
    const row = result.rows[0];
    if (row && !USER_ROLES.includes(row.role_code)) return null;
    return row ? {
      userId: Number(row.user_id),
      username: row.username,
      fullName: row.full_name,
      roleId: Number(row.role_id),
      roleCode: row.role_code,
    } : null;
  }

  async getRecentDealPayments(dealId: string, limit = 10): Promise<Array<{
    bitrixPaymentId: string;
    amount: string;
    paymentDate: string | null;
    paySystemName: string | null;
    state: string;
    erpPaymentId: number | null;
    source: 'widget' | 'native';
    commandStatus: WidgetCommandStatus | null;
  }>> {
    const result = await this.db.query<{
      bitrix_payment_id: string;
      amount: string | number;
      payment_local_date: Date | string | null;
      pay_system_name: string | null;
      state: string;
      erp_payment_id: string | number | null;
      manual_command_id: string | null;
      command_status: WidgetCommandStatus | null;
    }>(
      `SELECT payment.bitrix_payment_id, payment.amount,
              payment.payment_local_date, payment.pay_system_name,
              payment.state, payment.erp_payment_id,
              payment.manual_command_id, command.status AS command_status
         FROM bitrix24_incoming_request_payment payment
         LEFT JOIN bitrix24_manual_payment_command command
           ON command.command_id=payment.manual_command_id
        WHERE payment.request_id IN (
                SELECT request_id FROM bitrix24_incoming_request
                 WHERE bitrix_deal_id=$1
              )
           OR payment.erp_order_id IN (
                SELECT mapping.erp_id::bigint FROM crm_sync_mapping mapping
                 WHERE mapping.entity_type='order'
                   AND mapping.bitrix_object='deal'
                   AND mapping.bitrix_id=$1
                   AND mapping.status='active'
              )
        ORDER BY payment.payment_date DESC NULLS LAST,
                 payment.bitrix_payment_id::bigint DESC
        LIMIT $2`,
      [dealId, limit],
    );
    return result.rows.map((row) => ({
      bitrixPaymentId: row.bitrix_payment_id,
      amount: money(row.amount),
      paymentDate: toDateOnly(row.payment_local_date),
      paySystemName: row.pay_system_name,
      state: row.state,
      erpPaymentId: nullableNumber(row.erp_payment_id),
      source: row.manual_command_id ? 'widget' : 'native',
      commandStatus: row.command_status,
    }));
  }

  async getPaySystemCatalogState(): Promise<{
    count: number;
    lastFetchedAt: Date | null;
  }> {
    const result = await this.db.query<{
      count: string | number;
      last_fetched_at: Date | string | null;
    }>(
      `SELECT count(*) AS count, max(last_fetched_at) AS last_fetched_at
         FROM bitrix24_pay_system_catalog`,
    );
    return {
      count: Number(result.rows[0]?.count ?? 0),
      lastFetchedAt: result.rows[0]?.last_fetched_at
        ? new Date(result.rows[0].last_fetched_at)
        : null,
    };
  }

  async createSession(input: {
    tokenHash: string;
    memberId: string;
    domain: string;
    dealId: string;
    bitrixUserId: string;
    erpUserId: number;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    accessTokenExpiresAt: Date;
    expiresAt: Date;
  }): Promise<string> {
    const result = await this.db.query<{ session_id: string }>(
      `INSERT INTO bitrix24_widget_session (
         token_hash, member_id, domain, placement, bitrix_deal_id,
         bitrix_user_id, erp_user_id, access_token_ciphertext,
         refresh_token_ciphertext, access_token_expires_at, expires_at
       ) VALUES ($1,$2,$3,'CRM_DEAL_DETAIL_TAB',$4,$5,$6,$7,$8,$9,$10)
       RETURNING session_id`,
      [
        input.tokenHash,
        input.memberId,
        input.domain,
        input.dealId,
        input.bitrixUserId,
        input.erpUserId,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.accessTokenExpiresAt,
        input.expiresAt,
      ],
    );
    return result.rows[0].session_id;
  }

  async getSession(tokenHash: string): Promise<WidgetSession | null> {
    const result = await this.db.query<SessionRow>(
      `UPDATE bitrix24_widget_session session
          SET last_used_at=now()
         FROM bitrix24_app_installation installation
        WHERE session.token_hash=$1
          AND session.revoked_at IS NULL
          AND session.expires_at > now()
          AND installation.member_id=session.member_id
          AND installation.domain=session.domain
          AND installation.status='active'
       RETURNING session.session_id, session.member_id, session.domain,
                 session.bitrix_deal_id, session.bitrix_user_id,
                 session.erp_user_id, session.access_token_ciphertext,
                 session.refresh_token_ciphertext,
                 session.access_token_expires_at`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_widget_session SET revoked_at=COALESCE(revoked_at,now())
        WHERE session_id=$1`,
      [sessionId],
    );
  }

  async cleanupExpiredSessions(limit = 500): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM bitrix24_widget_session
        WHERE session_id IN (
          SELECT session_id FROM bitrix24_widget_session
           WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
           ORDER BY expires_at LIMIT $1
        )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  async cleanupExpiredCommandEscrow(retentionDays: number, limit = 200): Promise<number> {
    const result = await this.db.query(
      `WITH targets AS (
         SELECT command_id
           FROM bitrix24_manual_payment_command
          WHERE caller_access_token_ciphertext IS NOT NULL
            AND created_at < now()-make_interval(days=>$1)
          ORDER BY created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE bitrix24_manual_payment_command command
          SET caller_access_token_ciphertext=NULL,
              caller_refresh_token_ciphertext=NULL,
              caller_access_token_expires_at=NULL,
              status=CASE
                WHEN command.status IN ('processing','pre_create_saved') THEN 'failed_terminal'
                WHEN command.status='remote_created' THEN 'awaiting_actor_reauth'
                ELSE command.status
              END,
              error_code=CASE
                WHEN command.status IN ('processing','pre_create_saved')
                  THEN 'BITRIX24_COMMAND_ESCROW_EXPIRED'
                WHEN command.status='remote_created'
                  THEN 'BITRIX24_ACTOR_REAUTH_REQUIRED'
                ELSE command.error_code
              END,
              error_message=CASE
                WHEN command.status IN ('processing','pre_create_saved','remote_created')
                  THEN 'Bitrix24 caller token escrow retention expired'
                ELSE command.error_message
              END,
              completed_at=CASE
                WHEN command.status IN ('processing','pre_create_saved') THEN now()
                ELSE command.completed_at
              END,
              version=version+1,
              updated_at=now()
         FROM targets
        WHERE command.command_id=targets.command_id`,
      [retentionDays, limit],
    );
    return result.rowCount ?? 0;
  }

  async getDealContext(dealId: string): Promise<WidgetDealContext> {
    const request = await this.db.query<{
      request_id: string | number;
      state: string;
      linked_order_id: string | number | null;
      order_kind: string | null;
      version: string | number | null;
      final_amount: string | number | null;
      paid_amount: string | number | null;
      manager_id: string | number | null;
      created_by: string | number | null;
      has_details: boolean;
    }>(
      `SELECT request.request_id, request.state, request.linked_order_id,
              orders.order_kind, orders.version, orders.final_amount,
              orders.paid_amount, orders.manager_id, orders.created_by,
              EXISTS (
                SELECT 1 FROM order_details detail
                 WHERE detail.order_id=orders.order_id AND detail.delete_flag=false
              ) AS has_details
         FROM bitrix24_incoming_request request
         LEFT JOIN orders ON orders.order_id=request.linked_order_id
        WHERE request.bitrix_deal_id=$1
        LIMIT 1`,
      [dealId],
    );
    const requestRow = request.rows[0];
    if (requestRow) {
      return mapDealContext(dealId, requestRow, Number(requestRow.request_id));
    }
    const mapped = await this.db.query<{
      linked_order_id: string | number;
      order_kind: string;
      version: string | number;
      final_amount: string | number | null;
      paid_amount: string | number | null;
      manager_id: string | number | null;
      created_by: string | number | null;
      has_details: boolean;
    }>(
      `SELECT orders.order_id AS linked_order_id, orders.order_kind,
              orders.version, orders.final_amount, orders.paid_amount,
              orders.manager_id, orders.created_by,
              EXISTS (
                SELECT 1 FROM order_details detail
                 WHERE detail.order_id=orders.order_id AND detail.delete_flag=false
              ) AS has_details
         FROM crm_sync_mapping mapping
         JOIN orders ON orders.order_id=mapping.erp_id::bigint
        WHERE mapping.entity_type='order'
          AND mapping.bitrix_object='deal'
          AND mapping.bitrix_id=$1
          AND mapping.status='active'
          AND orders.delete_flag=false
        LIMIT 1`,
      [dealId],
    );
    const mappedRow = mapped.rows[0];
    if (!mappedRow) {
      return {
        dealId,
        requestId: null,
        requestState: null,
        orderId: null,
        orderKind: null,
        orderVersion: null,
        finalAmount: null,
        paidAmount: null,
        managerId: null,
        createdBy: null,
        hasActiveDetails: false,
      };
    }
    return mapDealContext(dealId, mappedRow, null);
  }

  async listWidgetPaymentSystems(forbiddenPaySystemId: number | null): Promise<WidgetPaymentSystem[]> {
    const result = await this.db.query<{
      pay_system_id: string | number;
      name: string;
      type_paid_id: string | number;
      is_default: boolean;
    }>(
      `SELECT catalog.pay_system_id, catalog.name, mapping.type_paid_id,
              mapping.is_default
         FROM bitrix24_pay_system_catalog catalog
         JOIN bitrix24_payment_type_mapping mapping
           ON mapping.pay_system_id=catalog.pay_system_id
          AND mapping.active=true AND mapping.widget_enabled=true
        WHERE catalog.active=true AND catalog.have_payment=true
          AND catalog.entity_registry_type='ORDER'
          AND ($1::integer IS NULL OR catalog.pay_system_id<>$1)
        ORDER BY mapping.is_default DESC, catalog.name, catalog.pay_system_id`,
      [forbiddenPaySystemId],
    );
    return result.rows.map((row) => ({
      paySystemId: Number(row.pay_system_id),
      name: row.name,
      typePaidId: Number(row.type_paid_id),
      isDefault: row.is_default,
    }));
  }

  async replacePaySystemCatalog(
    rows: Array<{
      paySystemId: number;
      name: string;
      description: string | null;
      xmlId: string | null;
      active: boolean;
      isCash: boolean;
      allowEditPayment: boolean;
      havePayment: boolean;
      entityRegistryType: string | null;
      personTypeId: number | null;
      rawHash: string;
    }>,
    audit?: { actorUserId: number; requestId: string },
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const seen: number[] = [];
      for (const row of rows) {
        seen.push(row.paySystemId);
        await tx.query(
          `INSERT INTO bitrix24_pay_system_catalog (
             pay_system_id, name, description, xml_id, active, is_cash,
             allow_edit_payment, have_payment, entity_registry_type,
             person_type_id, raw_hash, last_fetched_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
           ON CONFLICT (pay_system_id) DO UPDATE SET
             name=EXCLUDED.name, description=EXCLUDED.description,
             xml_id=EXCLUDED.xml_id, active=EXCLUDED.active,
             is_cash=EXCLUDED.is_cash,
             allow_edit_payment=EXCLUDED.allow_edit_payment,
             have_payment=EXCLUDED.have_payment,
             entity_registry_type=EXCLUDED.entity_registry_type,
             person_type_id=EXCLUDED.person_type_id,
             raw_hash=EXCLUDED.raw_hash, last_fetched_at=now(), updated_at=now()`,
          [
            row.paySystemId, row.name, row.description, row.xmlId, row.active,
            row.isCash, row.allowEditPayment, row.havePayment,
            row.entityRegistryType, row.personTypeId, row.rawHash,
          ],
        );
      }
      await tx.query(
        `UPDATE bitrix24_pay_system_catalog SET active=false, updated_at=now()
          WHERE NOT (pay_system_id=ANY($1::integer[]))`,
        [seen],
      );
      if (audit) {
        await this.audit.record(tx, {
          event: 'bitrix24.payment_system_catalog_refreshed',
          entityType: 'bitrix24_pay_system_catalog',
          entityId: 'catalog',
          actorUserId: audit.actorUserId,
          requestId: audit.requestId,
          source: 'backend-bitrix24',
          after: { count: rows.length, paySystemIds: seen },
        });
      }
      return rows.length;
    });
  }

  async createCommand(input: {
    idempotencyKey: string;
    requestHash: string;
    session: WidgetSession;
    installation: ActiveWidgetInstallation;
    deal: WidgetDealContext;
    amount: string;
    currencyId: string;
    paymentDate: string;
    paySystem: WidgetPaymentSystem;
    comment: string | null;
    confirmOverpayment: boolean;
    callerAccessTokenCiphertext: string;
    callerRefreshTokenCiphertext: string;
    callerAccessTokenExpiresAt: Date;
    originatingRequestId: string;
  }): Promise<{ command: ManualPaymentCommand; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<CommandRow>(
        `SELECT * FROM bitrix24_manual_payment_command
          WHERE member_id=$1 AND bitrix_actor_user_id=$2 AND idempotency_key=$3
          FOR UPDATE`,
        [input.session.memberId, input.session.bitrixUserId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== input.requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with another request');
        }
        return { command: mapCommand(existing.rows[0]), created: false };
      }
      try {
        const inserted = await tx.query<CommandRow>(
          `INSERT INTO bitrix24_manual_payment_command (
             idempotency_key, request_hash, member_id, domain, bitrix_deal_id,
             bitrix_actor_user_id, erp_actor_user_id, bitrix_executor_user_id,
             originating_request_id, request_id, erp_order_id,
             expected_order_version, amount,
             currency_id, payment_date, pay_system_id, type_paid_id, comment,
             overpayment_confirmed, overpayment_confirmed_by,
             overpayment_confirmed_at, caller_access_token_ciphertext,
             caller_refresh_token_ciphertext, caller_access_token_expires_at,
             token_user_id, status
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,CASE WHEN $19 THEN $7 ELSE NULL END,
             CASE WHEN $19 THEN now() ELSE NULL END,$20,$21,$22,$6,'processing'
           ) RETURNING *`,
          [
            input.idempotencyKey, input.requestHash, input.session.memberId,
            input.session.domain, input.session.dealId, input.session.bitrixUserId,
            input.session.erpUserId, input.installation.executorBitrixUserId,
            input.originatingRequestId, input.deal.requestId, input.deal.orderId,
            input.deal.orderKind === 'production_order' ? input.deal.orderVersion : null,
            input.amount, input.currencyId, input.paymentDate,
            input.paySystem.paySystemId, input.paySystem.typePaidId, input.comment,
            input.confirmOverpayment, input.callerAccessTokenCiphertext,
            input.callerRefreshTokenCiphertext, input.callerAccessTokenExpiresAt,
          ],
        );
        await this.audit.record(tx, {
          event: 'bitrix24.widget_payment.command_started',
          entityType: 'bitrix24_manual_payment_command',
          entityId: inserted.rows[0].command_id,
          actorUserId: input.session.erpUserId,
          requestId: input.originatingRequestId,
          source: 'bitrix24-widget',
          relatedOrderId: input.deal.orderId,
          statusField: 'command_status',
          statusCode: 'processing',
          after: { amount: input.amount, paymentDate: input.paymentDate },
          metadata: {
            bitrixActorUserId: input.session.bitrixUserId,
            bitrixExecutorUserId: input.installation.executorBitrixUserId,
            bitrixDealId: input.session.dealId,
            paySystemId: input.paySystem.paySystemId,
          },
        });
        return { command: mapCommand(inserted.rows[0]), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(
            'BITRIX24_PAYMENT_CREATE_IN_PROGRESS',
            'Another Bitrix24 payment create for this Deal requires completion',
          );
        }
        throw error;
      }
    });
  }

  async getCommand(commandId: string): Promise<ManualPaymentCommand | null> {
    const result = await this.db.query<CommandRow>(
      'SELECT * FROM bitrix24_manual_payment_command WHERE command_id=$1',
      [commandId],
    );
    return result.rows[0] ? mapCommand(result.rows[0]) : null;
  }

  async claimCommand(commandId: string, leaseMs: number): Promise<string | null> {
    const leaseToken = randomUUID();
    const result = await this.db.query<{ command_id: string }>(
      `UPDATE bitrix24_manual_payment_command
          SET lease_token=$2,
              lease_expires_at=now()+($3::integer * interval '1 millisecond'),
              updated_at=now()
        WHERE command_id=$1
          AND status IN (
            'processing','pre_create_saved','remote_create_started','remote_created',
            'snapshot_saved','awaiting_order','awaiting_order_ready','awaiting_erp_retry'
          )
          AND (lease_token IS NULL OR lease_expires_at < now())
        RETURNING command_id`,
      [commandId, leaseToken, leaseMs],
    );
    return result.rowCount === 1 ? leaseToken : null;
  }

  async releaseCommand(commandId: string, leaseToken: string): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_manual_payment_command
          SET lease_token=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE command_id=$1 AND lease_token=$2`,
      [commandId, leaseToken],
    );
  }

  async refreshExpectedOrderVersion(input: {
    commandId: string;
    actorBitrixUserId: string;
    expectedOrderVersion: number;
  }): Promise<ManualPaymentCommand> {
    const result = await this.db.query<CommandRow>(
      `UPDATE bitrix24_manual_payment_command
          SET expected_order_version=$3,
              status='snapshot_saved',
              error_code=NULL,
              error_message=NULL,
              version=version+1,
              updated_at=now()
        WHERE command_id=$1
          AND bitrix_actor_user_id=$2
          AND status='awaiting_erp_retry'
          AND error_code='ORDER_VERSION_STALE'
        RETURNING *`,
      [input.commandId, input.actorBitrixUserId, input.expectedOrderVersion],
    );
    if (!result.rows[0]) {
      throw conflict('BITRIX24_PAYMENT_COMMAND_STATE_CHANGED', 'Payment command state changed');
    }
    return mapCommand(result.rows[0]);
  }

  async updateCommandCallerTokens(input: {
    commandId: string;
    actorBitrixUserId: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    accessTokenExpiresAt: Date;
  }): Promise<ManualPaymentCommand> {
    const result = await this.db.query<CommandRow>(
      `UPDATE bitrix24_manual_payment_command
          SET caller_access_token_ciphertext=$3,
              caller_refresh_token_ciphertext=$4,
              caller_access_token_expires_at=$5,
              token_user_id=$2,
              status=CASE WHEN status='awaiting_actor_reauth'
                          THEN 'remote_created' ELSE status END,
              error_code=NULL, error_message=NULL,
              version=version+1, updated_at=now()
        WHERE command_id=$1
          AND bitrix_actor_user_id=$2
          AND status IN ('remote_created','awaiting_actor_reauth')
        RETURNING *`,
      [
        input.commandId,
        input.actorBitrixUserId,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.accessTokenExpiresAt,
      ],
    );
    if (!result.rows[0]) {
      throw conflict('BITRIX24_PAYMENT_COMMAND_STATE_CHANGED', 'Payment command cannot be reauthorized');
    }
    return mapCommand(result.rows[0]);
  }

  async refreshCommandCallerTokens(input: {
    commandId: string;
    actorBitrixUserId: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    accessTokenExpiresAt: Date;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE bitrix24_manual_payment_command
          SET caller_access_token_ciphertext=$3,
              caller_refresh_token_ciphertext=$4,
              caller_access_token_expires_at=$5,
              token_user_id=$2,
              version=version+1,
              updated_at=now()
        WHERE command_id=$1
          AND bitrix_actor_user_id=$2
          AND status IN (
            'processing','pre_create_saved','remote_created','snapshot_saved',
            'awaiting_erp_retry','awaiting_actor_reauth'
          )`,
      [
        input.commandId,
        input.actorBitrixUserId,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.accessTokenExpiresAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw conflict('BITRIX24_PAYMENT_COMMAND_STATE_CHANGED', 'Payment command state changed');
    }
  }

  async markAwaitingActorReauth(commandId: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_manual_payment_command
          SET status='awaiting_actor_reauth', error_code='BITRIX24_ACTOR_REAUTH_REQUIRED',
              error_message=$2, caller_access_token_ciphertext=NULL,
              caller_refresh_token_ciphertext=NULL,
              caller_access_token_expires_at=NULL,
              version=version+1, updated_at=now()
        WHERE command_id=$1 AND status='remote_created'`,
      [commandId, message.slice(0, 2000)],
    );
  }

  async savePreCreate(commandId: string, beforeIds: string[]): Promise<ManualPaymentCommand> {
    return this.transition(commandId, ['processing'], 'pre_create_saved', {
      beforePaymentIds: beforeIds,
      clearError: true,
    });
  }

  async markRemoteCreateStarted(commandId: string): Promise<ManualPaymentCommand> {
    return this.transition(commandId, ['pre_create_saved'], 'remote_create_started', {
      remoteCreateStarted: true,
      incrementAttempts: true,
      clearError: true,
    });
  }

  async markRemoteCreated(commandId: string, paymentId: string): Promise<ManualPaymentCommand> {
    const command = await this.transition(commandId, ['remote_create_started'], 'remote_created', {
      paymentId,
      remoteCreateResponded: true,
      clearError: true,
    });
    await this.audit.record(this.db, {
      event: 'bitrix24.widget_payment.remote_created',
      entityType: 'bitrix24_manual_payment_command',
      entityId: command.commandId,
      actorUserId: command.erpActorUserId,
      requestId: command.originatingRequestId,
      source: 'bitrix24-widget',
      relatedOrderId: command.erpOrderId,
      statusField: 'command_status',
      statusCode: 'remote_created',
      after: { bitrixPaymentId: paymentId },
      metadata: commandIdentity(command),
    });
    return command;
  }

  async markAmbiguous(
    commandId: string,
    code: string,
    message: string,
    diagnosticCandidateIds: string[] = [],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx.query<{ command_id: string }>(
        `UPDATE bitrix24_manual_payment_command
            SET status='remote_create_ambiguous', error_code=$2,
                error_message=$3, diagnostic_candidate_ids=$4::jsonb,
                lease_token=NULL, lease_expires_at=NULL,
                version=version+1, updated_at=now()
          WHERE command_id=$1 AND status='remote_create_started'
          RETURNING command_id`,
        [commandId, code, message.slice(0, 2000), JSON.stringify(diagnosticCandidateIds)],
      );
      if (updated.rowCount === 1) {
        await this.audit.record(tx, {
          event: 'bitrix24.widget_payment.failed',
          entityType: 'bitrix24_manual_payment_command',
          entityId: commandId,
          requestId: `bitrix24-widget:${commandId}`,
          source: 'bitrix24-widget',
          statusField: 'command_status',
          statusCode: 'remote_create_ambiguous',
          after: { errorCode: code },
        });
      }
    });
  }

  async resolveAmbiguity(input: {
    commandId: string;
    resolution: 'attach_existing' | 'confirm_absent';
    bitrixPaymentId?: string;
    expectedVersion: number;
    resolvedBy: number;
    reason: string;
    requestId: string;
  }): Promise<ManualPaymentCommand> {
    return this.db.transaction(async (tx) => {
      const command = await lockCommand(tx, input.commandId);
      if (
        command.status !== 'remote_create_ambiguous' ||
        command.version !== input.expectedVersion
      ) {
        throw conflict(
          'BITRIX24_PAYMENT_COMMAND_STATE_CHANGED',
          'Payment command state or version changed',
        );
      }

      let status: WidgetCommandStatus;
      let paymentId: string | null = null;
      if (input.resolution === 'attach_existing') {
        if (!input.bitrixPaymentId) {
          throw conflict('BITRIX24_PAYMENT_ID_MISSING', 'Bitrix24 payment ID is required');
        }
        const collision = await tx.query(
          `SELECT 1
             FROM bitrix24_manual_payment_command command
            WHERE command.bitrix_payment_id=$1 AND command.command_id<>$2
            UNION ALL
           SELECT 1
             FROM bitrix24_incoming_request_payment snapshot
            WHERE snapshot.bitrix_payment_id=$1
              AND (
                snapshot.erp_payment_id IS NOT NULL
                OR (
                  snapshot.manual_command_id IS NOT NULL
                  AND snapshot.manual_command_id<>$2
                )
              )
            UNION ALL
           SELECT 1
             FROM crm_sync_mapping mapping
            WHERE mapping.entity_type='payment'
              AND mapping.bitrix_id=$1
              AND mapping.status='active'
            LIMIT 1`,
          [input.bitrixPaymentId, input.commandId],
        );
        if (collision.rowCount) {
          throw conflict(
            'BITRIX24_PAYMENT_OWNER_CONFLICT',
            'Bitrix24 payment is already owned by another command or ERP payment',
          );
        }
        status = 'remote_created';
        paymentId = input.bitrixPaymentId;
      } else {
        status = 'confirmed_not_created';
      }

      const updated = await tx.query<CommandRow>(
        `UPDATE bitrix24_manual_payment_command
            SET status=$2,
                bitrix_payment_id=$3,
                resolution=$4,
                resolved_by=$5,
                resolution_reason=$6,
                resolved_at=now(),
                error_code=NULL,
                error_message=NULL,
                response_json=CASE WHEN $2='confirmed_not_created'
                  THEN jsonb_build_object(
                    'commandId',command_id,
                    'status','confirmed_not_created',
                    'message','Administrator confirmed that no Bitrix24 payment was created'
                  )
                  ELSE response_json END,
                completed_at=CASE WHEN $2='confirmed_not_created' THEN now() ELSE NULL END,
                caller_access_token_ciphertext=CASE WHEN $2='confirmed_not_created'
                  THEN NULL ELSE caller_access_token_ciphertext END,
                caller_refresh_token_ciphertext=CASE WHEN $2='confirmed_not_created'
                  THEN NULL ELSE caller_refresh_token_ciphertext END,
                caller_access_token_expires_at=CASE WHEN $2='confirmed_not_created'
                  THEN NULL ELSE caller_access_token_expires_at END,
                lease_token=NULL,
                lease_expires_at=NULL,
                version=version+1,
                updated_at=now()
          WHERE command_id=$1
          RETURNING *`,
        [
          input.commandId,
          status,
          paymentId,
          input.resolution,
          input.resolvedBy,
          input.reason,
        ],
      );
      const resolved = mapCommand(updated.rows[0]);
      await this.audit.record(tx, {
        event: 'bitrix24.widget_payment.ambiguity_resolved',
        entityType: 'bitrix24_manual_payment_command',
        entityId: resolved.commandId,
        actorUserId: input.resolvedBy,
        requestId: input.requestId,
        source: 'bitrix24-widget',
        relatedOrderId: resolved.erpOrderId,
        statusField: 'command_status',
        statusCode: status,
        after: {
          resolution: input.resolution,
          bitrixPaymentId: paymentId,
          reason: input.reason,
        },
        metadata: commandIdentity(resolved),
      });
      return resolved;
    });
  }

  async listAmbiguousCommands(): Promise<Array<{
    commandId: string;
    bitrixDealId: string;
    bitrixActorUserId: string;
    erpActorUserId: number;
    amount: string;
    currencyId: string;
    paymentDate: string;
    paySystemId: number;
    beforePaymentIds: string[];
    diagnosticCandidateIds: string[];
    version: number;
    errorCode: string | null;
    createdAt: string;
  }>> {
    const result = await this.db.query<{
      command_id: string;
      bitrix_deal_id: string;
      bitrix_actor_user_id: string;
      erp_actor_user_id: string | number;
      amount: string | number;
      currency_id: string;
      payment_date: Date | string;
      pay_system_id: string | number;
      before_payment_ids: unknown;
      diagnostic_candidate_ids: unknown;
      version: string | number;
      error_code: string | null;
      created_at: Date | string;
    }>(
      `SELECT command_id, bitrix_deal_id, bitrix_actor_user_id,
              erp_actor_user_id, amount, currency_id, payment_date,
              pay_system_id, before_payment_ids, diagnostic_candidate_ids,
              version, error_code, created_at
         FROM bitrix24_manual_payment_command
        WHERE status='remote_create_ambiguous'
        ORDER BY created_at`,
    );
    return result.rows.map((row) => ({
      commandId: row.command_id,
      bitrixDealId: row.bitrix_deal_id,
      bitrixActorUserId: row.bitrix_actor_user_id,
      erpActorUserId: Number(row.erp_actor_user_id),
      amount: money(row.amount),
      currencyId: row.currency_id,
      paymentDate: toDateOnly(row.payment_date) ?? '',
      paySystemId: Number(row.pay_system_id),
      beforePaymentIds: stringArray(row.before_payment_ids),
      diagnosticCandidateIds: stringArray(row.diagnostic_candidate_ids),
      version: Number(row.version),
      errorCode: row.error_code,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async saveVerifiedSnapshot(input: {
    command: ManualPaymentCommand;
    paymentName: string | null;
    paidAt: Date;
    normalizedHash: string;
    rawAmount: string;
    rawCurrency: string;
  }): Promise<ManualPaymentCommand> {
    return this.db.transaction(async (tx) => {
      const command = await lockCommand(tx, input.command.commandId);
      if (!command.bitrixPaymentId) throw conflict('BITRIX24_PAYMENT_ID_MISSING', 'Payment ID missing');
      const owner = await tx.query<{
        request_id: string | number | null;
        erp_order_id: string | number | null;
        manual_command_id: string | null;
      }>(
        `SELECT request_id, erp_order_id, manual_command_id
           FROM bitrix24_incoming_request_payment
          WHERE bitrix_payment_id=$1 FOR UPDATE`,
        [command.bitrixPaymentId],
      );
      const existing = owner.rows[0];
      const snapshotRequestId = command.requestId;
      const snapshotOrderId = command.requestId === null ? command.erpOrderId : null;
      if (
        existing &&
        (
          nullableNumber(existing.request_id) !== snapshotRequestId ||
          nullableNumber(existing.erp_order_id) !== snapshotOrderId ||
          (existing.manual_command_id && existing.manual_command_id !== command.commandId)
        )
      ) {
        throw conflict('BITRIX24_PAYMENT_OWNER_CONFLICT', 'Bitrix24 payment belongs to another ERP owner');
      }
      await tx.query(
        `INSERT INTO bitrix24_incoming_request_payment (
           bitrix_payment_id, request_id, erp_order_id, pay_system_id,
           pay_system_name, amount, currency_id, paid, payment_date,
           payment_local_date, normalized_hash, state, manual_command_id,
           bitrix_created_at, bitrix_updated_at, last_fetched_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,'active',$11,$8,$8,now(),now())
         ON CONFLICT (bitrix_payment_id) DO UPDATE SET
           pay_system_id=EXCLUDED.pay_system_id,
           pay_system_name=EXCLUDED.pay_system_name,
           amount=EXCLUDED.amount, currency_id=EXCLUDED.currency_id,
           paid=true, payment_date=EXCLUDED.payment_date,
           payment_local_date=EXCLUDED.payment_local_date,
           normalized_hash=EXCLUDED.normalized_hash,
           manual_command_id=EXCLUDED.manual_command_id,
           sync_version=bitrix24_incoming_request_payment.sync_version+1,
           state=CASE WHEN bitrix24_incoming_request_payment.erp_payment_id IS NULL
                      THEN 'active' ELSE 'materialized' END,
           bitrix_updated_at=EXCLUDED.bitrix_updated_at,
           last_fetched_at=now(), updated_at=now()`,
        [
          command.bitrixPaymentId, snapshotRequestId, snapshotOrderId,
          command.paySystemId, input.paymentName, input.rawAmount,
          input.rawCurrency, input.paidAt, command.paymentDate,
          input.normalizedHash, command.commandId,
        ],
      );
      const updated = await tx.query<CommandRow>(
        `UPDATE bitrix24_manual_payment_command
            SET status='snapshot_saved', error_code=NULL, error_message=NULL,
                version=version+1, updated_at=now()
          WHERE command_id=$1 AND status IN ('remote_created','awaiting_erp_retry')
          RETURNING *`,
        [command.commandId],
      );
      return updated.rows[0] ? mapCommand(updated.rows[0]) : command;
    });
  }

  async materializeCommand(commandId: string): Promise<ManualPaymentCommand> {
    return this.db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.crm_sync_origin', 'bitrix24', true)`);
      let command = await lockCommand(tx, commandId);
      if (command.status === 'completed') return command;
      if (!command.bitrixPaymentId) {
        throw conflict('BITRIX24_PAYMENT_ID_MISSING', 'Verified payment ID missing');
      }
      const target = await resolveCommandOrder(tx, command);
      if (!target.orderId) {
        command = await setAwaiting(tx, this.audit, command, 'awaiting_order');
        return command;
      }
      const order = await tx.query<{
        order_kind: string;
        version: string | number;
        final_amount: string | number | null;
        payment_status_id: string | number;
        manager_id: string | number | null;
        created_by: string | number | null;
        has_details: boolean;
      }>(
        `SELECT orders.order_kind, orders.version, orders.final_amount,
                orders.payment_status_id, orders.manager_id, orders.created_by,
                EXISTS (
                  SELECT 1 FROM order_details detail
                   WHERE detail.order_id=orders.order_id AND detail.delete_flag=false
                ) AS has_details
           FROM orders
          WHERE orders.order_id=$1 AND orders.delete_flag=false
          FOR UPDATE`,
        [target.orderId],
      );
      const orderRow = order.rows[0];
      if (!orderRow || orderRow.order_kind !== 'production_order') {
        command = await setAwaiting(tx, this.audit, command, 'awaiting_order');
        return command;
      }
      if (!orderRow.has_details) {
        command = await setAwaiting(tx, this.audit, command, 'awaiting_order_ready');
        return command;
      }
      if (
        command.expectedOrderVersion !== null &&
        Number(orderRow.version) !== command.expectedOrderVersion
      ) {
        throw conflict('ORDER_VERSION_STALE', 'ERP order changed; explicit retry is required');
      }
      const authorization = await tx.query(
        `SELECT 1
           FROM users actor
           JOIN roles role ON role.role_id=actor.role_id AND role.is_active=true
          WHERE actor.user_id=$1
            AND actor.is_active=true
            AND actor.is_service_account=false
            AND EXISTS (
              SELECT 1 FROM bitrix24_user_mapping mapping
               WHERE mapping.bitrix_user_id=$2
                 AND mapping.erp_user_id=actor.user_id
                 AND mapping.is_active=true
            )
            AND NOT EXISTS (
              SELECT 1 FROM unnest(ARRAY[
                'bitrix24.payments.create','payments.create','orders.view_financials'
              ]::text[]) required(permission_name)
               WHERE NOT EXISTS (
                 SELECT 1 FROM role_permissions permission
                  WHERE permission.role_id=actor.role_id
                    AND permission.permission_name=required.permission_name
                    AND permission.is_enabled=true
               )
            )
            AND EXISTS (
              SELECT 1 FROM role_policy_scopes scope
               WHERE scope.role_id=actor.role_id
                 AND scope.scope_key='payments.create'
                 AND (
                   scope.scope_value='all'
                   OR (
                     scope.scope_value='own'
                     AND ($3::bigint=actor.user_id OR $4::bigint=actor.user_id)
                   )
                 )
            )`,
        [
          command.erpActorUserId,
          command.bitrixActorUserId,
          nullableNumber(orderRow.manager_id),
          nullableNumber(orderRow.created_by),
        ],
      );
      if (authorization.rowCount !== 1) {
        throw new ApiError(
          403,
          'BITRIX24_WIDGET_PERMISSION_DENIED',
          'ERP actor no longer has permission for this order',
        );
      }
      const snapshot = await tx.query<{
        bitrix_payment_id: string;
        amount: string | number;
        currency_id: string | null;
        paid: boolean;
        payment_local_date: Date | string | null;
        normalized_hash: string;
        state: string;
        erp_payment_id: string | number | null;
      }>(
        `SELECT bitrix_payment_id, amount, currency_id, paid,
                payment_local_date, normalized_hash, state, erp_payment_id
           FROM bitrix24_incoming_request_payment
          WHERE bitrix_payment_id=$1 AND manual_command_id=$2
          FOR UPDATE`,
        [command.bitrixPaymentId, command.commandId],
      );
      const payment = snapshot.rows[0];
      if (
        !payment || !payment.paid ||
        !['active', 'materialized'].includes(payment.state) ||
        payment.currency_id !== command.currencyId ||
        payment.currency_id !== 'KZT' ||
        toDateOnly(payment.payment_local_date) !== command.paymentDate
      ) {
        throw conflict('BITRIX24_PAYMENT_SNAPSHOT_INVALID', 'Verified payment snapshot is invalid');
      }
      const totalsBefore = await tx.query<{ paid_amount: string | number }>(
        `SELECT COALESCE(SUM(amount),0) AS paid_amount
           FROM payments
          WHERE order_id=$1 AND delete_flag=false`,
        [target.orderId],
      );
      const paidBefore = roundMoney(Number(totalsBefore.rows[0]?.paid_amount ?? 0));
      const amount = roundMoney(Number(payment.amount));
      const finalAmount = roundMoney(Number(orderRow.final_amount ?? 0));
      const existingErpPaymentId = nullableNumber(payment.erp_payment_id);
      if (
        existingErpPaymentId === null &&
        finalAmount > 0 &&
        roundMoney(paidBefore + amount) > finalAmount &&
        !command.overpaymentConfirmed
      ) {
        command = await setAwaiting(
          tx,
          this.audit,
          command,
          'awaiting_overpayment_confirmation',
        );
        return command;
      }
      let erpPaymentId = existingErpPaymentId;
      const notes = `Платёж из Bitrix24 #${command.bitrixPaymentId}`;
      if (erpPaymentId === null) {
        const inserted = await tx.query<{ payment_id: string | number }>(
          `INSERT INTO payments (
             order_id, amount, payment_date, type_paid_id, notes,
             ref_key_1c, delete_flag
           ) VALUES ($1,$2,$3,$4,$5,NULL,false)
           RETURNING payment_id`,
          [target.orderId, amount, command.paymentDate, command.typePaidId, notes],
        );
        erpPaymentId = Number(inserted.rows[0].payment_id);
      } else {
        const exists = await tx.query(
          'SELECT 1 FROM payments WHERE payment_id=$1 FOR UPDATE',
          [erpPaymentId],
        );
        if (exists.rowCount !== 1) {
          throw conflict('BITRIX24_ERP_PAYMENT_MISSING', 'Mapped ERP payment is missing');
        }
        await tx.query(
          `UPDATE payments SET order_id=$2, amount=$3, payment_date=$4,
                  type_paid_id=$5, notes=$6, delete_flag=false, updated_at=now()
            WHERE payment_id=$1`,
          [erpPaymentId, target.orderId, amount, command.paymentDate, command.typePaidId, notes],
        );
      }
      await tx.query(
        `UPDATE bitrix24_incoming_request_payment
            SET state='materialized', erp_payment_id=$2, updated_at=now()
          WHERE bitrix_payment_id=$1`,
        [command.bitrixPaymentId, erpPaymentId],
      );
      await upsertPaymentMapping(
        tx,
        erpPaymentId,
        target.orderId,
        command.bitrixPaymentId,
        payment.normalized_hash,
      );
      const totals = await tx.query<{
        paid_amount: string | number;
        payment_date: Date | string | null;
      }>(
        `SELECT COALESCE(SUM(amount),0) AS paid_amount, MAX(payment_date) AS payment_date
           FROM payments WHERE order_id=$1 AND delete_flag=false`,
        [target.orderId],
      );
      const paidAmount = roundMoney(Number(totals.rows[0]?.paid_amount ?? 0));
      const paymentStatusId = calculatePaymentStatusId(
        Number(orderRow.payment_status_id),
        finalAmount,
        paidAmount,
      );
      await tx.query(
        `UPDATE orders SET paid_amount=$2, payment_date=$3,
                payment_status_id=$4, version=version+1
          WHERE order_id=$1`,
        [target.orderId, paidAmount, toDateOnly(totals.rows[0]?.payment_date ?? null), paymentStatusId],
      );
      const response = commandResponse(command, 'completed', target.orderId, erpPaymentId);
      const completed = await tx.query<CommandRow>(
        `UPDATE bitrix24_manual_payment_command
            SET status='completed', erp_order_id=$2, erp_payment_id=$3,
                materialization_executor_user_id=COALESCE(materialization_executor_user_id,erp_actor_user_id),
                response_json=$4::jsonb, completed_at=now(),
                caller_access_token_ciphertext=NULL,
                caller_refresh_token_ciphertext=NULL,
                caller_access_token_expires_at=NULL,
                error_code=NULL, error_message=NULL,
                version=version+1, updated_at=now()
          WHERE command_id=$1 RETURNING *`,
        [command.commandId, target.orderId, erpPaymentId, JSON.stringify(response)],
      );
      command = mapCommand(completed.rows[0]);
      await this.audit.record(tx, {
        event: 'bitrix24.widget_payment.materialized',
        entityType: 'bitrix24_manual_payment_command',
        entityId: command.commandId,
        actorUserId: command.erpActorUserId,
        requestId: command.originatingRequestId,
        source: 'bitrix24-widget',
        relatedOrderId: target.orderId,
        relatedPaymentId: erpPaymentId,
        statusField: 'command_status',
        statusCode: 'completed',
        before: { paidAmount: paidBefore },
        after: { paidAmount, erpPaymentId, bitrixPaymentId: command.bitrixPaymentId },
        metadata: commandIdentity(command),
      });
      await enqueueCommandEvent(tx, command, 'created_and_materialized', {
        orderId: target.orderId,
        erpPaymentId,
      });
      return command;
    });
  }

  async confirmOverpayment(input: {
    commandId: string;
    actorUserId: number;
  }): Promise<ManualPaymentCommand> {
    const result = await this.db.query<CommandRow>(
      `UPDATE bitrix24_manual_payment_command
          SET overpayment_confirmed=true, overpayment_confirmed_by=$2,
              overpayment_confirmed_at=now(), status='snapshot_saved',
              version=version+1, updated_at=now()
        WHERE command_id=$1
          AND status='awaiting_overpayment_confirmation'
        RETURNING *`,
      [input.commandId, input.actorUserId],
    );
    if (!result.rows[0]) {
      throw conflict('BITRIX24_PAYMENT_COMMAND_STATE_CHANGED', 'Payment command state changed');
    }
    return mapCommand(result.rows[0]);
  }

  async markPostCreateFailure(
    commandId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_manual_payment_command
          SET status=CASE WHEN status='snapshot_saved' THEN 'awaiting_erp_retry' ELSE status END,
              error_code=$2, error_message=$3, version=version+1, updated_at=now()
        WHERE command_id=$1
          AND status IN ('remote_created','snapshot_saved','awaiting_erp_retry')`,
      [commandId, code, message.slice(0, 2000)],
    );
  }

  async listRecoverableCommands(limit: number): Promise<ManualPaymentCommand[]> {
    const result = await this.db.query<CommandRow>(
      `SELECT * FROM bitrix24_manual_payment_command
        WHERE status IN (
          'processing','pre_create_saved','remote_create_started','remote_created',
          'snapshot_saved','awaiting_order','awaiting_order_ready','awaiting_erp_retry'
        )
          AND updated_at < now() - interval '5 seconds'
        ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapCommand);
  }

  async markCrashedCreateAmbiguous(commandId: string): Promise<void> {
    await this.markAmbiguous(
      commandId,
      'BITRIX24_PAYMENT_CREATE_INTERRUPTED',
      'Payment create was interrupted after the durable start marker',
    );
  }

  private async transition(
    commandId: string,
    from: WidgetCommandStatus[],
    to: WidgetCommandStatus,
    options: {
      beforePaymentIds?: string[];
      paymentId?: string;
      remoteCreateStarted?: boolean;
      remoteCreateResponded?: boolean;
      incrementAttempts?: boolean;
      clearError?: boolean;
    },
  ): Promise<ManualPaymentCommand> {
    const result = await this.db.query<CommandRow>(
      `UPDATE bitrix24_manual_payment_command
          SET status=$2,
              before_payment_ids=COALESCE($3::jsonb,before_payment_ids),
              bitrix_payment_id=COALESCE($4,bitrix_payment_id),
              remote_create_started_at=CASE WHEN $5 THEN now() ELSE remote_create_started_at END,
              remote_create_response_at=CASE WHEN $6 THEN now() ELSE remote_create_response_at END,
              attempts=attempts+CASE WHEN $7 THEN 1 ELSE 0 END,
              error_code=CASE WHEN $8 THEN NULL ELSE error_code END,
              error_message=CASE WHEN $8 THEN NULL ELSE error_message END,
              version=version+1, updated_at=now()
        WHERE command_id=$1 AND status=ANY($9::text[])
        RETURNING *`,
      [
        commandId,
        to,
        options.beforePaymentIds ? JSON.stringify(options.beforePaymentIds) : null,
        options.paymentId ?? null,
        options.remoteCreateStarted ?? false,
        options.remoteCreateResponded ?? false,
        options.incrementAttempts ?? false,
        options.clearError ?? false,
        from,
      ],
    );
    if (!result.rows[0]) {
      const current = await this.getCommand(commandId);
      if (current) return current;
      throw new ApiError(404, 'BITRIX24_PAYMENT_COMMAND_NOT_FOUND', 'Payment command not found');
    }
    return mapCommand(result.rows[0]);
  }
}

async function lockCommand(
  tx: TransactionClient,
  commandId: string,
): Promise<ManualPaymentCommand> {
  const result = await tx.query<CommandRow>(
    'SELECT * FROM bitrix24_manual_payment_command WHERE command_id=$1 FOR UPDATE',
    [commandId],
  );
  if (!result.rows[0]) {
    throw new ApiError(404, 'BITRIX24_PAYMENT_COMMAND_NOT_FOUND', 'Payment command not found');
  }
  return mapCommand(result.rows[0]);
}

async function resolveCommandOrder(
  tx: TransactionClient,
  command: ManualPaymentCommand,
): Promise<{ orderId: number | null }> {
  if (command.requestId !== null) {
    const result = await tx.query<{ linked_order_id: string | number | null }>(
      `SELECT linked_order_id FROM bitrix24_incoming_request
        WHERE request_id=$1 AND bitrix_deal_id=$2 FOR UPDATE`,
      [command.requestId, command.bitrixDealId],
    );
    return { orderId: nullableNumber(result.rows[0]?.linked_order_id ?? null) };
  }
  return { orderId: command.erpOrderId };
}

async function setAwaiting(
  tx: TransactionClient,
  audit: AuditService,
  command: ManualPaymentCommand,
  status: 'awaiting_order' | 'awaiting_order_ready' | 'awaiting_overpayment_confirmation',
): Promise<ManualPaymentCommand> {
  if (command.status === status) return command;
  const response = commandResponse(command, status, command.erpOrderId, null);
  const result = await tx.query<CommandRow>(
    `UPDATE bitrix24_manual_payment_command
        SET status=$2, response_json=$3::jsonb,
            caller_access_token_ciphertext=NULL,
            caller_refresh_token_ciphertext=NULL,
            caller_access_token_expires_at=NULL,
            version=version+1, updated_at=now()
      WHERE command_id=$1 RETURNING *`,
    [command.commandId, status, JSON.stringify(response)],
  );
  const updated = mapCommand(result.rows[0]);
  await audit.record(tx, {
    event: status === 'awaiting_overpayment_confirmation'
      ? 'bitrix24.widget_payment.awaiting_overpayment_confirmation'
      : 'bitrix24.widget_payment.awaiting_order',
    entityType: 'bitrix24_manual_payment_command',
    entityId: command.commandId,
    actorUserId: command.erpActorUserId,
    requestId: command.originatingRequestId,
    source: 'bitrix24-widget',
    relatedOrderId: command.erpOrderId,
    statusField: 'command_status',
    statusCode: status,
    after: { status },
    metadata: commandIdentity(command),
  });
  await enqueueCommandEvent(
    tx,
    updated,
    status === 'awaiting_overpayment_confirmation'
      ? 'awaiting_overpayment_confirmation'
      : 'awaiting_order',
    { orderId: command.erpOrderId, erpPaymentId: null },
  );
  return updated;
}

async function upsertPaymentMapping(
  tx: TransactionClient,
  paymentId: number,
  orderId: number,
  bitrixPaymentId: string,
  normalizedHash: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO crm_sync_mapping (
       entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id,
       status, source_system, last_bitrix_hash, last_error, attempts,
       last_synced_at, updated_at
     ) VALUES ('payment',$1,'payment',$2,$3,'active','bitrix24',$4,NULL,0,now(),now())
     ON CONFLICT (entity_type,erp_id) DO UPDATE SET
       bitrix_object='payment', bitrix_id=EXCLUDED.bitrix_id,
       parent_erp_id=EXCLUDED.parent_erp_id, status='active',
       source_system='bitrix24', last_bitrix_hash=EXCLUDED.last_bitrix_hash,
       last_error=NULL, attempts=0, last_synced_at=now(), updated_at=now()`,
    [String(paymentId), bitrixPaymentId, String(orderId), normalizedHash],
  );
}

async function enqueueCommandEvent(
  tx: TransactionClient,
  command: ManualPaymentCommand,
  result: 'created_and_materialized' | 'awaiting_order' | 'awaiting_overpayment_confirmation',
  related: { orderId: number | null; erpPaymentId: number | null },
): Promise<void> {
  const eventType = `bitrix24.payment.${result}`;
  await tx.query(
    `INSERT INTO outbox_events (
       event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
     ) VALUES ($1,'bitrix24_manual_payment_command',$2,$3::jsonb,$4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      eventType,
      command.commandId,
      JSON.stringify({
        commandId: command.commandId,
        requestId: command.originatingRequestId,
        originatingRequestId: command.originatingRequestId,
        actorUserId: command.erpActorUserId,
        actorType: 'erp_user_mapped_from_bitrix',
        bitrixActorUserId: command.bitrixActorUserId,
        bitrixExecutorUserId: command.bitrixExecutorUserId,
        bitrixDealId: command.bitrixDealId,
        bitrixPaymentId: command.bitrixPaymentId,
        orderId: related.orderId,
        requestEntityId: command.requestId,
        erpPaymentId: related.erpPaymentId,
        amount: command.amount,
        currencyId: command.currencyId,
        paymentDate: command.paymentDate,
        typePaidId: command.typePaidId,
        source: 'bitrix24-widget',
        result,
      }),
      `bitrix24.widget_payment:${command.commandId}:${result}`,
    ],
  );
}

function commandResponse(
  command: ManualPaymentCommand,
  status: WidgetCommandStatus,
  orderId: number | null,
  erpPaymentId: number | null,
): Record<string, unknown> {
  return {
    commandId: command.commandId,
    status,
    bitrixPaymentId: command.bitrixPaymentId,
    erpPaymentId,
    dealId: command.bitrixDealId,
    orderId,
    amount: command.amount,
    currencyId: command.currencyId,
    paymentDate: command.paymentDate,
  };
}

function commandIdentity(command: ManualPaymentCommand): Record<string, unknown> {
  return {
    bitrixActorUserId: command.bitrixActorUserId,
    bitrixExecutorUserId: command.bitrixExecutorUserId,
    bitrixDealId: command.bitrixDealId,
    bitrixPaymentId: command.bitrixPaymentId,
    paySystemId: command.paySystemId,
    commandId: command.commandId,
  };
}

function mapSession(row: SessionRow): WidgetSession {
  return {
    sessionId: row.session_id,
    memberId: row.member_id,
    domain: row.domain,
    dealId: row.bitrix_deal_id,
    bitrixUserId: row.bitrix_user_id,
    erpUserId: Number(row.erp_user_id),
    accessTokenCiphertext: row.access_token_ciphertext,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    accessTokenExpiresAt: new Date(row.access_token_expires_at),
  };
}

function mapInstallAttempt(row: {
  attempt_id: string;
  member_id: string;
  domain: string;
  application_token_hash: string;
  executor_bitrix_user_id: string;
  expires_at: Date | string;
}): WidgetInstallAttempt {
  return {
    attemptId: row.attempt_id,
    memberId: row.member_id,
    domain: row.domain,
    applicationTokenHash: row.application_token_hash,
    executorBitrixUserId: row.executor_bitrix_user_id,
    expiresAt: new Date(row.expires_at),
  };
}

function mapCommand(row: CommandRow): ManualPaymentCommand {
  return {
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    memberId: row.member_id,
    domain: row.domain,
    bitrixDealId: row.bitrix_deal_id,
    bitrixActorUserId: row.bitrix_actor_user_id,
    erpActorUserId: Number(row.erp_actor_user_id),
    bitrixExecutorUserId: row.bitrix_executor_user_id,
    originatingRequestId: row.originating_request_id,
    requestId: nullableNumber(row.request_id),
    erpOrderId: nullableNumber(row.erp_order_id),
    expectedOrderVersion: nullableNumber(row.expected_order_version),
    bitrixPaymentId: row.bitrix_payment_id,
    erpPaymentId: nullableNumber(row.erp_payment_id),
    amount: money(row.amount),
    currencyId: row.currency_id,
    paymentDate: toDateOnly(row.payment_date) ?? '',
    paySystemId: Number(row.pay_system_id),
    typePaidId: Number(row.type_paid_id),
    comment: row.comment,
    overpaymentConfirmed: row.overpayment_confirmed,
    beforePaymentIds: stringArray(row.before_payment_ids),
    diagnosticCandidateIds: stringArray(row.diagnostic_candidate_ids),
    status: row.status,
    version: Number(row.version),
    callerAccessTokenCiphertext: row.caller_access_token_ciphertext,
    callerRefreshTokenCiphertext: row.caller_refresh_token_ciphertext,
    callerAccessTokenExpiresAt: row.caller_access_token_expires_at
      ? new Date(row.caller_access_token_expires_at)
      : null,
    response: row.response_json,
    errorCode: row.error_code,
  };
}

function mapDealContext(
  dealId: string,
  row: {
    state?: string;
    linked_order_id: string | number | null;
    order_kind: string | null;
    version: string | number | null;
    final_amount: string | number | null;
    paid_amount: string | number | null;
    manager_id: string | number | null;
    created_by: string | number | null;
    has_details: boolean;
  },
  requestId: number | null,
): WidgetDealContext {
  return {
    dealId,
    requestId,
    requestState: row.state ?? null,
    orderId: nullableNumber(row.linked_order_id),
    orderKind: row.order_kind,
    orderVersion: nullableNumber(row.version),
    finalAmount: row.final_amount === null ? null : money(row.final_amount),
    paidAmount: row.paid_amount === null ? null : money(row.paid_amount),
    managerId: nullableNumber(row.manager_id),
    createdBy: nullableNumber(row.created_by),
    hasActiveDetails: Boolean(row.has_details),
  };
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function money(value: string | number): string {
  return Number(value).toFixed(2);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((item) => /^[1-9][0-9]*$/.test(item));
}

function toDateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

export function hashWidgetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newWidgetRequestId(): string {
  return randomUUID();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === '23505';
}

function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}
