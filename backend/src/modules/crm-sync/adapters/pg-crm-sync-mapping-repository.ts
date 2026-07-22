import type { DatabaseClient } from '../../../database/database.types';
import type {
  MappingRow,
  PaymentCreateGuardRow,
} from '../application/crm-sync.types';

export class PgCrmSyncMappingRepository {
  async get(
    client: DatabaseClient,
    entityType: string,
    erpId: string,
  ): Promise<MappingRow | null> {
    const result = await client.query<{
      entity_type: string;
      erp_id: string;
      bitrix_object: string;
      bitrix_id: string | null;
      parent_erp_id: string | null;
      status: string;
      last_hash: string | null;
    }>(
      `SELECT entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id, status, last_hash
         FROM crm_sync_mapping
        WHERE entity_type=$1 AND erp_id=$2`,
      [entityType, erpId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      entityType: row.entity_type,
      erpId: row.erp_id,
      bitrixObject: row.bitrix_object,
      bitrixId: row.bitrix_id ?? null,
      parentErpId: row.parent_erp_id ?? null,
      status: row.status,
      lastHash: row.last_hash ?? null,
    };
  }

  async listByParent(
    client: DatabaseClient,
    entityType: string,
    parentErpId: string,
  ): Promise<MappingRow[]> {
    const result = await client.query<{
      entity_type: string;
      erp_id: string;
      bitrix_object: string;
      bitrix_id: string | null;
      parent_erp_id: string | null;
      status: string;
      last_hash: string | null;
    }>(
      `SELECT entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id, status, last_hash
         FROM crm_sync_mapping
        WHERE entity_type=$1 AND parent_erp_id=$2
        ORDER BY erp_id`,
      [entityType, parentErpId],
    );
    return result.rows.map((row) => ({
      entityType: row.entity_type,
      erpId: row.erp_id,
      bitrixObject: row.bitrix_object,
      bitrixId: row.bitrix_id ?? null,
      parentErpId: row.parent_erp_id ?? null,
      status: row.status,
      lastHash: row.last_hash ?? null,
    }));
  }

  async upsertSuccess(client: DatabaseClient, row: MappingRow): Promise<void> {
    await client.query(
      `INSERT INTO crm_sync_mapping (
         entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id,
         status, last_hash, last_error, attempts, last_synced_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,0, now(), now())
       ON CONFLICT (entity_type, erp_id) DO UPDATE SET
         bitrix_object=EXCLUDED.bitrix_object, bitrix_id=EXCLUDED.bitrix_id,
         parent_erp_id=EXCLUDED.parent_erp_id,
         status=EXCLUDED.status, last_hash=EXCLUDED.last_hash,
         last_error=NULL, attempts=0, last_synced_at=now(), updated_at=now()`,
      [
        row.entityType,
        row.erpId,
        row.bitrixObject,
        row.bitrixId,
        row.parentErpId,
        row.status,
        row.lastHash,
      ],
    );
  }

  async markFailed(
    client: DatabaseClient,
    entityType: string,
    erpId: string,
    bitrixObject: string,
    error: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, status, last_error, attempts, updated_at)
       VALUES ($1,$2,$3,'failed',$4,1, now())
       ON CONFLICT (entity_type, erp_id) DO UPDATE SET
         status='failed', last_error=EXCLUDED.last_error, attempts=crm_sync_mapping.attempts+1, updated_at=now()`,
      [entityType, erpId, bitrixObject, error.slice(0, 1000)],
    );
  }

  async getPaymentCreateGuard(
    client: DatabaseClient,
    erpPaymentId: string,
  ): Promise<PaymentCreateGuardRow | null> {
    const result = await client.query<{
      erp_payment_id: string;
      erp_order_id: string;
      bitrix_deal_id: string;
      before_ids: unknown;
    }>(
      `SELECT erp_payment_id, erp_order_id, bitrix_deal_id, before_ids
         FROM crm_sync_payment_create_guard
        WHERE erp_payment_id=$1`,
      [erpPaymentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!Array.isArray(row.before_ids) || row.before_ids.some((id) => !isBitrixId(id))) {
      throw new Error(`CRM sync: invalid payment create guard for ERP payment ${erpPaymentId}`);
    }
    return {
      erpPaymentId: row.erp_payment_id,
      erpOrderId: row.erp_order_id,
      bitrixDealId: row.bitrix_deal_id,
      beforeIds: row.before_ids.map(String),
    };
  }

  async listPaymentCreateGuardsByOrder(
    client: DatabaseClient,
    erpOrderId: string,
  ): Promise<PaymentCreateGuardRow[]> {
    const result = await client.query<{
      erp_payment_id: string;
      erp_order_id: string;
      bitrix_deal_id: string;
      before_ids: unknown;
    }>(
      `SELECT erp_payment_id, erp_order_id, bitrix_deal_id, before_ids
         FROM crm_sync_payment_create_guard
        WHERE erp_order_id=$1
        ORDER BY erp_payment_id`,
      [erpOrderId],
    );
    return result.rows.map((row) => {
      if (!Array.isArray(row.before_ids) || row.before_ids.some((id) => !isBitrixId(id))) {
        throw new Error(
          `CRM sync: invalid payment create guard for ERP payment ${row.erp_payment_id}`,
        );
      }
      return {
        erpPaymentId: row.erp_payment_id,
        erpOrderId: row.erp_order_id,
        bitrixDealId: row.bitrix_deal_id,
        beforeIds: row.before_ids.map(String),
      };
    });
  }

  async insertPaymentCreateGuard(
    client: DatabaseClient,
    guard: PaymentCreateGuardRow,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO crm_sync_payment_create_guard (
         erp_payment_id, erp_order_id, bitrix_deal_id, before_ids
       )
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (erp_payment_id) DO NOTHING`,
      [
        guard.erpPaymentId,
        guard.erpOrderId,
        guard.bitrixDealId,
        JSON.stringify(guard.beforeIds),
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async deletePaymentCreateGuard(
    client: DatabaseClient,
    erpPaymentId: string,
  ): Promise<void> {
    await client.query(
      'DELETE FROM crm_sync_payment_create_guard WHERE erp_payment_id=$1',
      [erpPaymentId],
    );
  }
}

function isBitrixId(value: unknown): value is string | number {
  return (
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}
