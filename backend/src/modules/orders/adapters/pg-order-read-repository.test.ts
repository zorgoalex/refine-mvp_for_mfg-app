import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgOrderReadRepository } from './pg-order-read-repository';

describe('PgOrderReadRepository', () => {
  it('lists orders with pagination, whitelist sort and soft-delete filter', async () => {
    const database = createDatabase();
    const repository = new PgOrderReadRepository(database.service);

    await expect(
      repository.listOrders({
        currentUser: currentUser('42'),
        query: {
          page: 2,
          pageSize: 10,
          sortBy: 'debtAmount',
          sortOrder: 'asc',
          search: 'client',
          dateFrom: '2026-05-01',
          onlyMyOrders: true,
        },
      }),
    ).resolves.toMatchObject({
      data: [
        {
          orderId: 100,
          orderName: 'A-100',
          debtAmount: 70,
          notes: 'List note',
          materialIds: [10, 11],
          materialNames: ['MDF 16', 'MDF 18'],
          millingTypeId: 1,
          millingTypeName: 'Modern',
          dowelingOrderId: 700,
          dowelingOrderName: '1368',
          designEngineerId: 8,
          passedProductionStatusCodes: ['cut', 'paint'],
          version: 3,
        },
      ],
      pagination: {
        page: 2,
        pageSize: 10,
        total: 11,
        totalPages: 2,
      },
    });

    const listQuery = database.queries.find((query) => query.text.includes('LIMIT'))?.text ?? '';
    expect(listQuery).toContain('o.delete_flag = false');
    expect(listQuery).toContain('LEFT JOIN LATERAL');
    expect(listQuery).toContain('FROM order_details od');
    expect(listQuery).toContain('FROM order_doweling_links odl');
    expect(listQuery).toContain('FROM production_status_events pse');
    expect(listQuery).toContain('ORDER BY (o.final_amount - o.paid_amount) ASC');
    expect(database.queries.at(-1)?.params).toEqual(['%client%', '2026-05-01', 42, 10, 10]);
  });

  it('loads full order aggregate from base tables', async () => {
    const repository = new PgOrderReadRepository(createDatabase().service);

    await expect(
      repository.getOrderById({
        currentUser: currentUser('42'),
        orderId: 100,
      }),
    ).resolves.toMatchObject({
      header: {
        orderId: 100,
        orderName: 'A-100',
        clientId: 5,
        paymentStatusId: 2,
      },
      details: [{ id: 200, detailNumber: 1, detailCost: 120 }],
      payments: [{ id: 300, amount: 50 }],
      workshops: [{ id: 400, workshopId: 1 }],
      requirements: [{ id: 500, resourceType: 'material' }],
      dowelingLinks: [{ id: 600, dowelingOrderId: 700 }],
      totals: {
        totalAmount: 120,
        paidAmount: 50,
        debtAmount: 70,
      },
      version: 3,
    });
  });
});

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 11 }] };
      }

      if (text.includes('FROM orders o')) {
        return { rows: [orderRow()] };
      }

      if (text.includes('FROM order_details')) {
        return {
          rows: [
            {
              detail_id: 200,
              order_id: 100,
              detail_number: 1,
              detail_name: 'Side',
              height: '1000',
              width: '500',
              quantity: 2,
              area: '1.00',
              material_id: 10,
              milling_type_id: 1,
              edge_type_id: 1,
              film_id: null,
              milling_cost_per_sqm: null,
              detail_cost: '120.00',
              priority: 100,
              production_status_id: null,
              joint_order_id: null,
              note: null,
              link_cutting_file: null,
              link_cutting_image_file: null,
              link_cad_file: null,
              link_pdf_file: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM payments')) {
        return {
          rows: [
            {
              payment_id: 300,
              order_id: 100,
              type_paid_id: 1,
              amount: '50.00',
              payment_date: '2026-05-01',
              notes: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_workshops')) {
        return {
          rows: [
            {
              order_workshop_id: 400,
              order_id: 100,
              workshop_id: 1,
              production_status_id: 2,
              received_date: null,
              started_date: null,
              completed_date: null,
              planned_completion_date: '2026-05-03',
              sequence_order: 1,
              responsible_employee_id: null,
              notes: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_resource_requirements')) {
        return {
          rows: [
            {
              requirement_id: 500,
              order_id: 100,
              resource_type: 'material',
              material_id: 10,
              film_id: null,
              edge_type_id: null,
              required_quantity: '2',
              unit_id: 1,
              waste_percentage: '10',
              final_quantity: '2.2',
              requirement_status_id: 1,
              supplier_id: null,
              purchase_price: null,
              requisition_id: null,
              warehouse_id: null,
              reserved_at: null,
              consumed_at: null,
              notes: null,
              calculation_details: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      if (text.includes('FROM order_doweling_links')) {
        return {
          rows: [
            {
              order_doweling_link_id: 600,
              order_id: 100,
              doweling_order_id: 700,
              design_engineer_id: null,
              ref_key_1c: null,
            },
          ],
        };
      }

      return { rows: [] };
    },
  } as unknown as DatabaseService;

  return { service, queries };
}

function orderRow() {
  return {
    order_id: 100,
    order_name: 'A-100',
    client_id: 5,
    client_name: 'Client',
    order_date: '2026-05-01',
    priority: 100,
    order_status_id: 1,
    order_status_name: 'Новый',
    payment_status_id: 2,
    payment_status_name: 'Частично оплачен',
    production_status_id: null,
    production_status_name: null,
    production_status_from_details_enabled: false,
    planned_completion_date: '2026-05-10',
    completion_date: null,
    issue_date: null,
    payment_date: '2026-05-01',
    discount: '0',
    surcharge: '0',
    notes: 'List note',
    manager_id: 42,
    link_cutting_file: null,
    link_cutting_image_file: null,
    link_cad_file: null,
    link_pdf_file: null,
    total_amount: '120.00',
    final_amount: '120.00',
    paid_amount: '50.00',
    parts_count: 2,
    total_area: '1.00',
    created_at: new Date('2026-05-01T10:00:00.000Z'),
    updated_at: new Date('2026-05-01T11:00:00.000Z'),
    version: 3,
    ref_key_1c: null,
    material_ids: [10, 11],
    material_names: ['MDF 16', 'MDF 18'],
    milling_type_id: 1,
    milling_type_name: 'Modern',
    latest_doweling_order_id: 700,
    latest_doweling_order_name: '1368',
    latest_design_engineer_id: 8,
    passed_production_status_codes: ['cut', 'paint'],
  };
}

function currentUser(id: string): CurrentUser {
  return {
    id,
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}
