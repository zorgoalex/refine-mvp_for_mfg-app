import { describe, expect, it } from 'vitest';
import {
  mapOrderListItemToLegacyRow,
  mapOrderDtoToFormValues,
  mapOrderFormToSaveOrderDto,
  normalizeDateOnly,
  stripFrontendOnlyFields,
} from './orderMapper';
import type { OrderFormValues } from '../../types/orders';
import type { OrderDto } from '../types/orderApi.types';

describe('orderMapper', () => {
  it('maps OrderFormValues to SaveOrderDto without frontend-only fields', () => {
    const values = createFormValues();

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.version).toBe(9);
    expect(dto.header).toMatchObject({
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-29',
      priority: 100,
      orderStatusId: 3,
      paymentStatusId: null,
      productionStatusId: null,
      productionStatusFromDetailsEnabled: true,
      plannedCompletionDate: '2026-05-02',
      completionDate: null,
      discount: 0,
      surcharge: 250,
      managerId: null,
      linkCuttingFile: null,
      notes: null,
      refKey1c: 'erp-ref',
    });
    expect(dto.header).not.toHaveProperty('order_id');
    expect(dto.header).not.toHaveProperty('totalAmount');

    expect(dto.details).toHaveLength(2);
    expect(dto.details.map((detail) => detail.detailNumber)).toEqual([1, 2]);
    expect(dto.details[0]).toMatchObject({
      clientKey: '202',
      height: 100,
      width: 200,
      quantity: 3,
      materialId: 4,
      millingTypeId: 5,
      edgeTypeId: 6,
      detailCost: 600,
    });
    expect(dto.details[1]).toMatchObject({
      id: 51,
      clientKey: '101',
      detailName: 'Shelf',
      filmId: null,
      millingCostPerSqm: 12.5,
      detailCost: 1750,
      note: null,
      priority: 100,
    });

    expect(dto.payments).toEqual([
      {
        id: undefined,
        clientKey: '301',
        typePaidId: 2,
        amount: 1000,
        paymentDate: '2026-04-30',
        notes: null,
        refKey1c: 'pay-ref',
      },
    ]);
    expect(dto.workshops[0]).toMatchObject({
      clientKey: '401',
      workshopId: 7,
      productionStatusId: 8,
      receivedDate: '2026-05-01',
      sequenceOrder: null,
      responsibleEmployeeId: null,
    });
    expect(dto.requirements[0]).toMatchObject({
      clientKey: '501',
      resourceType: 'material',
      materialId: 4,
      filmId: null,
      requiredQuantity: 12.5,
      unitId: 1,
      requirementStatusId: 2,
      reservedAt: '2026-05-01T10:00:00.000Z',
    });
    expect(dto.dowelingLinks[0]).toMatchObject({
      id: 91,
      clientKey: '601',
      dowelingOrderId: 44,
      designEngineerId: 7,
      refKey1c: null,
    });
    expect(dto.deleted).toEqual({
      detailIds: [51, 52],
      paymentIds: [71],
      workshopIds: [81],
      requirementIds: [82],
      dowelingLinkIds: [91],
      hdfDetailIds: [],
    });

    const json = JSON.stringify(dto);
    expect(json).not.toContain('created_by');
    expect(json).not.toContain('updated_at');
    expect(json).not.toContain('delete_flag');
    expect(json).not.toContain('temp_id');
    expect(json).not.toContain('area');
    expect(json).not.toContain('total_amount');
    expect(json).not.toContain('doweling_order_name');
  });

  it('emits PDF-import intent only for marked new detail client keys', () => {
    const values = createFormValues();
    values.pdfImportCandidateTempIds = [101, 202, 999999];

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.bazisImportCandidateClientKeys).toEqual(['202']);
    expect(JSON.stringify(dto.details)).not.toContain('pdfImportCandidateTempIds');
  });

  it('maps operational child workflow collections to SaveOrderDto', () => {
    const values = createFormValues();
    values.details = [];
    values.payments = [];
    values.deletedDetails = [];
    values.deletedPayments = [];
    values.workshops = [
      {
        order_workshop_id: 81,
        order_id: 10,
        workshop_id: '7' as unknown as number,
        production_status_id: '8' as unknown as number,
        received_date: '2026-05-01T09:00:00.000Z',
        started_date: null,
        completed_date: '',
        planned_completion_date: undefined,
        sequence_order: '' as unknown as number,
        responsible_employee_id: '' as unknown as number,
        notes: '  ',
        ref_key_1c: 'workshop-ref',
        created_by: 1,
      },
    ];
    values.requirements = [
      {
        requirement_id: 91,
        order_id: 10,
        resource_type: 'material',
        material_id: '4' as unknown as number,
        film_id: '' as unknown as number,
        edge_type_id: null,
        required_quantity: '12.5' as unknown as number,
        unit_id: '1' as unknown as number,
        waste_percentage: '' as unknown as number,
        final_quantity: null,
        requirement_status_id: '2' as unknown as number,
        supplier_id: '' as unknown as number,
        purchase_price: '30' as unknown as number,
        requisition_id: null,
        warehouse_id: undefined,
        reserved_at: new Date('2026-05-01T10:00:00.000Z'),
        consumed_at: '',
        notes: '',
        calculation_details: ' ',
        is_active: false,
        ref_key_1c: 'requirement-ref',
        created_by: 1,
      },
    ];
    values.dowelingLinks = [
      {
        order_doweling_link_id: 101,
        temp_id: 2001,
        order_id: 10,
        doweling_order_id: '44' as unknown as number,
        doweling_order: {
          doweling_order_id: 44,
          doweling_order_name: 'Doweling A',
          design_engineer_id: '7' as unknown as number,
          design_engineer: 'Engineer',
        },
        ref_key_1c: '',
        created_by: 1,
      },
    ];
    values.deletedWorkshops = [82, 0];
    values.deletedRequirements = [92, -1];
    values.deletedDowelingLinks = [102, 102];

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.workshops).toEqual([
      {
        id: 81,
        clientKey: undefined,
        workshopId: 7,
        productionStatusId: 8,
        receivedDate: '2026-05-01',
        startedDate: null,
        completedDate: null,
        plannedCompletionDate: null,
        sequenceOrder: null,
        responsibleEmployeeId: null,
        notes: null,
        refKey1c: 'workshop-ref',
      },
    ]);
    expect(dto.requirements).toEqual([
      {
        id: 91,
        clientKey: undefined,
        resourceType: 'material',
        materialId: 4,
        filmId: null,
        edgeTypeId: null,
        requiredQuantity: 12.5,
        unitId: 1,
        wastePercentage: null,
        finalQuantity: null,
        requirementStatusId: 2,
        supplierId: null,
        purchasePrice: 30,
        requisitionId: null,
        warehouseId: null,
        reservedAt: '2026-05-01T10:00:00.000Z',
        consumedAt: null,
        notes: null,
        calculationDetails: null,
        refKey1c: 'requirement-ref',
      },
    ]);
    expect(dto.dowelingLinks).toEqual([
      {
        id: 101,
        clientKey: '2001',
        dowelingOrderId: 44,
        designEngineerId: 7,
        refKey1c: null,
      },
    ]);
    expect(dto.deleted).toEqual({
      detailIds: [],
      paymentIds: [],
      workshopIds: [82],
      requirementIds: [92],
      dowelingLinkIds: [102],
      hdfDetailIds: [],
    });
    const json = JSON.stringify(dto);
    expect(json).not.toContain('created_by');
    expect(json).not.toContain('is_active');
    expect(json).not.toContain('doweling_order_name');
  });

  it('throws on missing required values instead of coercing them to zero', () => {
    const missingClient = createFormValues();
    missingClient.header.client_id = '' as unknown as number;
    expect(() => mapOrderFormToSaveOrderDto(missingClient)).toThrow(
      'Invalid number: header.client_id',
    );

    const missingExistingDetailHeight = createFormValues();
    missingExistingDetailHeight.details[0].height = '' as unknown as number;
    expect(() => mapOrderFormToSaveOrderDto(missingExistingDetailHeight)).toThrow(
      'Invalid number: detail.height',
    );
  });

  it('omits only new empty tail details from save payloads', () => {
    const values = createFormValues();
    values.details = [
      {
        ...values.details[1],
        temp_id: 202,
        detail_number: 1,
      },
      {
        ...values.details[1],
        temp_id: 203,
        detail_number: 2,
        height: 0,
        width: 0,
        quantity: null as unknown as number,
        area: 0,
        milling_cost_per_sqm: null,
        detail_cost: null,
        note: 'tail draft',
      },
    ];

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.details).toHaveLength(1);
    expect(dto.details[0].clientKey).toBe('202');
  });

  it('keeps partially filled new tail details for validation', () => {
    const values = createFormValues();
    values.details = [
      {
        ...values.details[1],
        temp_id: 202,
        detail_number: 1,
      },
      {
        ...values.details[1],
        temp_id: 203,
        detail_number: 2,
        height: 50,
        width: 0,
        quantity: null as unknown as number,
        area: 0,
        milling_cost_per_sqm: null,
        detail_cost: null,
      },
    ];

    expect(() => mapOrderFormToSaveOrderDto(values)).toThrow('Invalid number: detail.quantity');
  });

  it('keeps incomplete new details before later valid details for validation', () => {
    const values = createFormValues();
    values.details = [
      {
        ...values.details[1],
        temp_id: 203,
        detail_number: 1,
        height: 0,
        width: 0,
        quantity: null as unknown as number,
        area: 0,
        milling_cost_per_sqm: null,
        detail_cost: null,
      },
      {
        ...values.details[1],
        temp_id: 202,
        detail_number: 2,
      },
    ];

    expect(() => mapOrderFormToSaveOrderDto(values)).toThrow('Invalid number: detail.quantity');
  });

  it('preserves legacy zero version on update payloads', () => {
    const values = createFormValues();
    values.version = 0;
    values.header.version = 0;

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.version).toBe(0);
  });

  it('passes projectId and idempotencyKey to SaveOrderDto', () => {
    const values = createFormValues();
    values.header.project_id = 42;
    values.idempotencyKey = 'k-123456789';

    const dto = mapOrderFormToSaveOrderDto(values);

    expect(dto.header.projectId).toBe(42);
    expect(dto.idempotencyKey).toBe('k-123456789');
  });

  it('omits projectId when project is not chosen', () => {
    const valuesWithNull = createFormValues();
    valuesWithNull.header.project_id = null;

    const dtoWithNull = mapOrderFormToSaveOrderDto(valuesWithNull);

    expect(dtoWithNull.header.projectId).toBeNull();

    const valuesWithUndefined = createFormValues();
    delete valuesWithUndefined.header.project_id;

    const dtoWithUndefined = mapOrderFormToSaveOrderDto(valuesWithUndefined);

    expect(dtoWithUndefined.header.projectId).toBeNull();
  });

  it('maps project fields and full order number into LegacyOrderListRow', () => {
    const row = mapOrderListItemToLegacyRow({
      orderId: 1258,
      orderName: '1258',
      clientId: 10,
      clientName: 'Клиент',
      orderDate: '2026-07-05',
      orderStatusId: 1,
      paymentStatusId: 2,
      productionStatusId: 3,
      projectId: 7,
      projectCode: 'ФК26',
      fullNumber: 'ФК26-1258',
      version: 4,
    });

    expect(row.project_id).toBe(7);
    expect(row.project_code).toBe('ФК26');
    expect(row.order_full_number).toBe('ФК26-1258');
  });

  it('maps OrderDto back to OrderFormValues and restores stable temp ids', () => {
    const dto: OrderDto = {
      header: {
        orderId: 15,
        orderName: 'Backend Order',
        clientId: 12,
        orderDate: '2026-04-29',
        priority: null,
        orderStatusId: 3,
        paymentStatusId: 4,
        productionStatusId: 5,
        productionStatusFromDetailsEnabled: true,
        plannedCompletionDate: '2026-05-05',
        completionDate: null,
        issueDate: null,
        paymentDate: '2026-05-01',
        discount: 100,
        surcharge: 0,
        materialId: 20,
        millingTypeId: 21,
        edgeTypeId: 22,
        filmId: null,
        linkCuttingFile: null,
        linkCuttingImageFile: null,
        linkCadFile: 'cad.dxf',
        linkPdfFile: null,
        notes: 'done',
        refKey1c: 'order-ref',
        createdBy: 15,
        editedBy: 16,
        version: 4,
      },
      details: [
        {
          id: 71,
          clientKey: '1700000000001',
          orderId: 15,
          detailNumber: 1,
          detailName: 'Top',
          height: 500,
          width: 400,
          quantity: 2,
          area: 0.4,
          materialId: 4,
          millingTypeId: 5,
          edgeTypeId: 6,
          filmId: null,
          millingCostPerSqm: 11,
          detailCost: 800,
          priority: null,
          productionStatusId: 8,
          note: null,
          refKey1c: 'detail-ref',
        },
      ],
      payments: [
        {
          id: 81,
          clientKey: 'not-numeric',
          orderId: 15,
          typePaidId: 2,
          amount: 400,
          paymentDate: '2026-04-30',
          notes: null,
          refKey1c: 'payment-ref',
        },
      ],
      workshops: [
        {
          id: 91,
          clientKey: '901',
          orderId: 15,
          workshopId: 7,
          productionStatusId: 8,
          receivedDate: null,
          startedDate: '2026-05-02',
          completedDate: null,
          plannedCompletionDate: '2026-05-06',
          sequenceOrder: 2,
          responsibleEmployeeId: null,
          notes: 'workshop note',
          refKey1c: 'workshop-ref',
        },
      ],
      requirements: [
        {
          id: 92,
          clientKey: '902',
          orderId: 15,
          resourceType: 'material',
          materialId: 4,
          filmId: null,
          edgeTypeId: null,
          requiredQuantity: 3,
          unitId: 1,
          wastePercentage: null,
          finalQuantity: 3,
          requirementStatusId: 2,
          supplierId: null,
          purchasePrice: 55,
          requisitionId: null,
          warehouseId: 6,
          reservedAt: null,
          consumedAt: null,
          notes: null,
          calculationDetails: null,
          refKey1c: 'requirement-ref',
        },
      ],
      dowelingLinks: [
        {
          id: 93,
          clientKey: '903',
          orderId: 15,
          dowelingOrderId: 44,
          designEngineerId: 7,
          designEngineerName: 'Engineer',
          refKey1c: 'link-ref',
          dowelingOrder: {
            id: 44,
            name: 'Doweling A',
            designEngineerId: 7,
            designEngineerName: 'Engineer',
          },
        },
      ],
      totals: {
        totalAmount: 800,
        discount: 100,
        surcharge: 0,
        finalAmount: 700,
        paidAmount: 400,
        debtAmount: 300,
        partsCount: 2,
        totalArea: 0.4,
      },
      version: 4,
    };

    const form = mapOrderDtoToFormValues(dto);

    expect(form.version).toBe(4);
    expect(form.isDirty).toBe(false);
    expect(form.header).toMatchObject({
      order_id: 15,
      order_name: 'Backend Order',
      client_id: 12,
      priority: 100,
      total_amount: 800,
      final_amount: 700,
      paid_amount: 400,
      parts_count: 2,
      total_area: 0.4,
      created_by: 15,
      edited_by: 16,
      version: 4,
      doweling_order_id: 44,
      doweling_order_name: 'Doweling A',
    });
    expect(form.details[0]).toMatchObject({
      detail_id: 71,
      temp_id: 1700000000001,
      order_id: 15,
      area: 0.4,
      priority: 100,
    });
    expect(form.payments[0]).toMatchObject({
      payment_id: 81,
      temp_id: 81,
      order_id: 15,
      ref_key_1c: 'payment-ref',
    });
    expect(form.workshops[0].temp_id).toBe(901);
    expect(form.requirements[0].temp_id).toBe(902);
    expect(form.dowelingLinks[0]).toMatchObject({
      order_doweling_link_id: 93,
      temp_id: 903,
      doweling_order_id: 44,
      doweling_order: {
        doweling_order_id: 44,
        doweling_order_name: 'Doweling A',
        design_engineer_id: 7,
        design_engineer: 'Engineer',
      },
    });
    expect(form.deletedDetails).toEqual([]);
    expect(form.deletedPayments).toEqual([]);
    expect(form.deletedWorkshops).toEqual([]);
    expect(form.deletedRequirements).toEqual([]);
    expect(form.deletedDowelingLinks).toEqual([]);

    const dtoWithoutTotals = {
      ...dto,
      header: {
        ...dto.header,
        totalAmount: 810,
        finalAmount: 710,
        paidAmount: 410,
        partsCount: 3,
        totalArea: 0.45,
      },
      totals: undefined,
    } as unknown as OrderDto;

    const formWithoutTotals = mapOrderDtoToFormValues(dtoWithoutTotals);

    expect(formWithoutTotals.header).toMatchObject({
      total_amount: 810,
      final_amount: 710,
      paid_amount: 410,
      parts_count: 3,
      total_area: 0.45,
    });
  });

  // Variant B: sheet-only material contract
  it('emits materialId: null for a sheet detail (Variant B)', () => {
    const form = createFormValues();
    const sheetDetail = {
      ...form.details[1],
      sheet_material_type_id: 2,
      material_id: null as unknown as number,
    };
    form.details = [sheetDetail];
    const dto = mapOrderFormToSaveOrderDto(form);
    expect(dto.details[0].materialId).toBeNull();
    expect(dto.details[0].sheetMaterialTypeId).toBe(2);
  });

  it('emits materialId: null on the order header (Variant B sunset)', () => {
    const form = createFormValues();
    form.header.material_id = null as unknown as number;
    const dto = mapOrderFormToSaveOrderDto(form);
    expect(dto.header.materialId).toBeNull();
  });

  it('normalizes dayjs-like dates and strips frontend-only fields', () => {
    expect(normalizeDateOnly({ format: () => '2026-04-30' })).toBe('2026-04-30');
    expect(
      stripFrontendOnlyFields({
        order_id: 1,
        created_at: '2026-04-30T00:00:00.000Z',
        order_name: 'Visible',
        total_amount: 100,
      }),
    ).toEqual({ order_name: 'Visible' });
  });
});

function createFormValues(): OrderFormValues {
  return {
    header: {
      order_id: 10,
      order_name: '  Order A  ',
      client_id: '12' as unknown as number,
      project_id: undefined,
      order_date: new Date('2026-04-29T00:00:00.000Z'),
      priority: '' as unknown as number,
      order_status_id: '3' as unknown as number,
      payment_status_id: '' as unknown as number,
      production_status_id: '' as unknown as number,
      production_status_from_details_enabled: '' as unknown as boolean,
      planned_completion_date: '2026-05-02T12:30:00.000Z',
      completion_date: '',
      issue_date: null,
      total_amount: 9999,
      final_amount: 9999,
      paid_amount: 9999,
      parts_count: 99,
      total_area: 99,
      discount: '' as unknown as number,
      surcharge: '250' as unknown as number,
      payment_date: null,
      material_id: '4' as unknown as number,
      milling_type_id: '' as unknown as number,
      edge_type_id: null,
      film_id: undefined,
      link_cutting_file: ' ',
      link_cutting_image_file: '',
      link_cad_file: null,
      link_pdf_file: undefined,
      notes: ' ',
      manager_id: '' as unknown as number,
      delete_flag: true,
      ref_key_1c: ' erp-ref ',
      created_by: 1,
      updated_at: '2026-04-30T00:00:00.000Z',
      version: 7,
    },
    details: [
      {
        detail_id: 51,
        temp_id: 101,
        order_id: 10,
        detail_number: 2,
        detail_name: ' Shelf ',
        height: '700' as unknown as number,
        width: '500' as unknown as number,
        quantity: '2' as unknown as number,
        area: 0.7,
        material_id: '4' as unknown as number,
        milling_type_id: '5' as unknown as number,
        edge_type_id: '6' as unknown as number,
        film_id: '' as unknown as number,
        milling_cost_per_sqm: '12.5' as unknown as number,
        detail_cost: '1750' as unknown as number,
        note: '',
        priority: '' as unknown as number,
        production_status_id: '' as unknown as number,
        joint_order_id: null,
        link_cutting_file: '',
        link_cutting_image_file: null,
        link_cad_file: undefined,
        link_pdf_file: ' ',
        ref_key_1c: 'detail-ref',
        created_by: 1,
        updated_at: '2026-04-30T00:00:00.000Z',
      },
      {
        temp_id: 202,
        detail_number: 1,
        height: 100,
        width: 200,
        quantity: 3,
        area: 0.06,
        material_id: 4,
        milling_type_id: 5,
        edge_type_id: 6,
        film_id: null,
        milling_cost_per_sqm: null,
        detail_cost: 600,
        note: 'ok',
        priority: 10,
      },
      {
        temp_id: 203,
        detail_number: 3,
        height: 0,
        width: 0,
        quantity: 1,
        area: 0,
        material_id: 1,
        milling_type_id: 1,
        edge_type_id: 1,
        detail_cost: null,
        priority: 100,
      },
    ],
    payments: [
      {
        temp_id: 301,
        type_paid_id: '2' as unknown as number,
        amount: '1000' as unknown as number,
        payment_date: { format: () => '2026-04-30' } as unknown as string,
        notes: '',
        ref_key_1c: 'pay-ref',
        created_by: 1,
      },
      {
        temp_id: 302,
        type_paid_id: 2,
        amount: 0,
        payment_date: '2026-04-30',
      },
    ],
    workshops: [
      {
        temp_id: 401,
        order_workshop_id: undefined,
        order_id: 10,
        workshop_id: '7' as unknown as number,
        production_status_id: '8' as unknown as number,
        received_date: '2026-05-01T09:00:00.000Z',
        started_date: null,
        completed_date: '',
        planned_completion_date: undefined,
        sequence_order: '' as unknown as number,
        responsible_employee_id: '' as unknown as number,
        notes: '  ',
        ref_key_1c: 'workshop-ref',
        created_by: 1,
      },
    ],
    requirements: [
      {
        temp_id: 501,
        order_id: 10,
        resource_type: 'material',
        material_id: '4' as unknown as number,
        film_id: '' as unknown as number,
        edge_type_id: null,
        required_quantity: '12.5' as unknown as number,
        unit_id: '1' as unknown as number,
        waste_percentage: '' as unknown as number,
        final_quantity: null,
        requirement_status_id: '2' as unknown as number,
        supplier_id: '' as unknown as number,
        purchase_price: '30' as unknown as number,
        requisition_id: null,
        warehouse_id: undefined,
        reserved_at: new Date('2026-05-01T10:00:00.000Z'),
        consumed_at: '',
        notes: '',
        calculation_details: ' ',
        is_active: false,
        ref_key_1c: 'requirement-ref',
        created_by: 1,
      },
    ],
    dowelingLinks: [
      {
        order_doweling_link_id: 91,
        temp_id: 601,
        order_id: 10,
        doweling_order_id: '44' as unknown as number,
        doweling_order: {
          doweling_order_id: 44,
          doweling_order_name: 'Doweling A',
          design_engineer_id: '7' as unknown as number,
          design_engineer: 'Engineer',
        },
        ref_key_1c: '',
        created_by: 1,
      },
    ],
    deletedDetails: [51, 0, -1, 52, 51],
    deletedPayments: [71, 0],
    deletedWorkshops: [81],
    deletedRequirements: [82],
    deletedDowelingLinks: [91],
    isDirty: true,
    version: 9,
    idempotencyKey: undefined,
  };
}
