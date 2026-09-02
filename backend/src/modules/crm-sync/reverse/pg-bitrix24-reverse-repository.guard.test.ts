import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./pg-bitrix24-reverse-repository.ts', import.meta.url),
  'utf8',
);
const controllerSource = readFileSync(
  new URL('./bitrix24-reverse-admin.controller.ts', import.meta.url),
  'utf8',
);

describe('Bitrix24 reverse repository financial guards', () => {
  it('requires explicit materialization for active request payments', () => {
    expect(source).toMatch(
      /materializeRequestPayments[\s\S]*materializeActivePayments\([\s\S]*true/,
    );
    expect(source).not.toMatch(/replaceRequestPaymentSnapshots[\s\S]*syncMaterializedPayments/);
    expect(source).not.toMatch(/replaceMappedOrderPaymentSnapshots[\s\S]*syncMappedOrderPayments/);
    expect(controllerSource).toContain(
      "@RequirePermissions(['bitrix24.payments.materialize', 'orders.view_financials'])",
    );
    expect(controllerSource).toMatch(
      /materializeRequestPayments[\s\S]*scope: crmRequestScope\(actor\)/,
    );
    expect(source).toMatch(
      /materializeRequestPayments[\s\S]*\(\$2::boolean OR orders\.manager_id=\$3\)/,
    );
    expect(source).toContain('payment.sync_version');
    expect(source).toMatch(/UPDATE payments[\s\S]*IS DISTINCT FROM/);
    expect(source).toContain(
      'bitrix24.payment.materialized:${payment.bitrix_payment_id}:${payment.sync_version}',
    );
    expect(source).toMatch(/updated\.rowCount !== 1[\s\S]*paymentChanged = true/);
    expect(source).toContain('async materializeMappedOrderPayments');
    expect(controllerSource).toContain("@Post('mapped-orders/:orderId/materialize-payments')");
  });

  it('reads the canonical payment type name column', () => {
    expect(source).toContain('type.type_paid_name AS type_paid_name');
    expect(source).toContain('type.type_paid_name, mapping.active');
    expect(source).not.toMatch(/type\.type_paid(?!_)/);
  });

  it('edits CRM request details in place with optimistic and aggregate guards', () => {
    expect(source).toMatch(/replaceIncomingRequestDetails[\s\S]*FOR UPDATE OF request, orders/);
    expect(source).toMatch(/aggregate\.order_kind !== 'crm_request'/);
    expect(source).toMatch(/aggregate\.version !== input\.orderVersion/);
    expect(source).toMatch(/UPDATE order_details[\s\S]*delete_flag=true/);
    expect(source).toMatch(/INSERT INTO order_details/);
    expect(source).toMatch(/SET parts_count=\$2, total_area=\$3, total_amount=\$4/);
    expect(source).toContain("event: 'orders.crm_request_updated'");
    expect(source).toContain('Financial detail fields require orders.view_financials');
    expect(source).toContain('mapIncomingRequestDetail(detail, input.canViewFinancials)');
  });

  it('redacts CRM financial data without orders.view_financials', () => {
    expect(controllerSource).toContain(
      "actor.permissions.includes('orders.view_financials')",
    );
    expect(source).toMatch(/input\.canViewFinancials \? \{[\s\S]*crmAmount/);
    expect(source).toMatch(/canViewFinancials \? payments\.rows\.map/);
  });

  it('converts the same row once and emits durable production initialization', () => {
    expect(source).toMatch(/convertCrmRequestToProduction[\s\S]*order_kind='production_order'/);
    expect(source).toMatch(/UPDATE orders[\s\S]*order_kind='production_order'/);
    expect(source).toContain("eventType: 'orders.production_initialized'");
    expect(source).toContain('production-init:${input.orderId}:${input.idempotencyKey}');
    expect(source).toContain("event: 'project.created'");
    expect(source).toMatch(/convertCrmRequestToProduction[\s\S]*SUM\(detail_cost\)[\s\S]*final_amount=\$10/);
  });

  it('resumes unresolved Deals after exact counterparty mapping', () => {
    expect(source).toContain('enqueueUnresolvedDealsForCounterparty');
    expect(source).toContain("request.state='unresolved'");
    expect(source).toContain("'counterpartyObjectType',$1::text");
    expect(source).toContain("'counterpartyBitrixId',$2::text");
    expect(source).toContain('request.counterparty_object_type=$1');
    expect(source).toContain('request.counterparty_bitrix_id=$2');
  });

  it('keeps the Deal mapping parent aligned with an active request client change', () => {
    expect(source).toContain("requestIsActive && snapshot.clientId !== null");
    expect(source).toContain('parentErpId: nextParentErpId');
  });

  it('keeps exact client identity while exposing an unresolved counterparty conflict', () => {
    expect(source).toMatch(
      /counterparty_object_type=CASE[\s\S]*snapshot\.clientId === null[\s\S]*COUNTERPARTY_UNRESOLVED/,
    );
    expect(source).toContain('recordSyncConflict');
    expect(source).toMatch(
      /mapping\.lastBitrixHash === snapshot\.normalizedHash[\s\S]*COUNTERPARTY_UNRESOLVED[\s\S]*snapshot\.clientId === null/,
    );
  });

  it('supports ERP-only archive and retries blocked conflicts', () => {
    expect(source).toContain('async archiveIncomingRequest');
    expect(source).toContain("archived_by_source='erp_user'");
    expect(source).toContain("request.sync_status='blocked'");
    expect(source).toContain('BITRIX24_ADMIN_RETRY_DEAL');
    expect(source).toMatch(
      /archived_by_source === 'erp_user'[\s\S]*mapping\.lastBitrixHash === snapshot\.normalizedHash/,
    );
    expect(source).toMatch(
      /RESTORE_VERSION_CONFLICT'[\s\S]*mapping\.lastBitrixHash === snapshot\.normalizedHash/,
    );
    expect(controllerSource).toContain("@Post('incoming-requests/:requestId/archive')");
  });

  it('validates the service actor before reverse mutations start', () => {
    expect(source).toContain('async assertReverseSyncReady');
    expect(source).toContain("actor_role.role_code='integration_service'");
  });

  it('manages responsible-user mappings with active non-service targets and audit', () => {
    expect(source).toContain('async upsertUserMapping');
    expect(source).toContain('is_active=true AND is_service_account=false');
    expect(source).toContain("event: 'bitrix24.user_mapping_upserted'");
  });
});
