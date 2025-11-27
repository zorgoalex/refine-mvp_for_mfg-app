// Zod Validation Schemas for Order Form
// Based on PostgreSQL schema v11.6 and business requirements

import { z } from 'zod';

// ============================================================================
// HELPER SCHEMAS
// ============================================================================

// Financial validation helper
const financialSchema = z.object({
  total_amount: z.number().min(0, "Сумма должна быть >= 0").nullable().optional(),
  discount: z.number().min(0, "Скидка должна быть >= 0").max(100, "Скидка не может превышать 100%").default(0),
  discounted_amount: z.number().min(0, "Сумма со скидкой должна быть >= 0").nullable().optional(),
  paid_amount: z.number().min(0, "Оплаченная сумма должна быть >= 0").default(0),
  payment_date: z.date().nullable().optional().or(z.string().nullable().optional()),
});

// ============================================================================
// ORDER HEADER SCHEMA
// ============================================================================

export const orderHeaderSchema = z
  .object({
    // Required fields
    order_name: z
      .string()
      .min(2, "Название заказа должно содержать минимум 2 символа")
      .max(200, "Название заказа не может превышать 200 символов"),
    client_id: z.number().positive("Выберите клиента"),
    order_date: z.date().or(z.string()),
    priority: z.number().min(1, "Приоритет >= 1").max(100, "Приоритет <= 100").default(100),
    order_status_id: z.number().positive("Выберите статус заказа"),
    payment_status_id: z.number().positive("Выберите статус оплаты"),

    // Optional dates
    planned_completion_date: z.date().nullable().optional().or(z.string().nullable().optional()),
    completion_date: z.date().nullable().optional().or(z.string().nullable().optional()),
    issue_date: z.date().nullable().optional().or(z.string().nullable().optional()),

    // Financial fields
    total_amount: financialSchema.shape.total_amount,
    discount: financialSchema.shape.discount,
    discounted_amount: financialSchema.shape.discounted_amount,
    paid_amount: financialSchema.shape.paid_amount,
    payment_date: financialSchema.shape.payment_date,

    // Aggregates (read-only, will be calculated)
    parts_count: z.number().int().min(0).optional(),
    total_area: z.number().min(0).optional(),

    // Legacy fields (for compatibility)
    material_id: z.number().nullable().optional(),
    milling_type_id: z.number().nullable().optional(),
    edge_type_id: z.number().nullable().optional(),
    film_id: z.number().nullable().optional(),

    // File links
    link_cutting_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
    link_cutting_image_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
    link_cad_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
    link_pdf_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),

    // Management
    manager_id: z.number().nullable().optional(),

    // System fields
    order_id: z.number().optional(),
    delete_flag: z.boolean().optional(),
    version: z.number().int().optional(),
    ref_key_1c: z.string().nullable().optional(),
    created_by: z.number().optional(),
    edited_by: z.number().nullable().optional(),
    created_at: z.date().optional().or(z.string().optional()),
    updated_at: z.date().optional().or(z.string().optional()),
  })
  .refine(
    (data) => {
      // Validation: discounted_amount <= total_amount
      if (data.discounted_amount && data.total_amount) {
        return data.discounted_amount <= data.total_amount;
      }
      return true;
    },
    {
      message: "Сумма со скидкой не может превышать исходную сумму",
      path: ["discounted_amount"],
    }
  )
  .refine(
    (data) => {
      // Validation: completion_date >= order_date
      if (data.completion_date && data.order_date) {
        const completionDate = new Date(data.completion_date);
        const orderDate = new Date(data.order_date);
        return completionDate >= orderDate;
      }
      return true;
    },
    {
      message: "Дата завершения не может быть раньше даты заказа",
      path: ["completion_date"],
    }
  )
  .refine(
    (data) => {
      // Validation: planned_completion_date >= order_date
      if (data.planned_completion_date && data.order_date) {
        const plannedDate = new Date(data.planned_completion_date);
        const orderDate = new Date(data.order_date);
        return plannedDate >= orderDate;
      }
      return true;
    },
    {
      message: "Плановая дата завершения не может быть раньше даты заказа",
      path: ["planned_completion_date"],
    }
  )
  .refine(
    (data) => {
      // Validation: issue_date >= order_date
      if (data.issue_date && data.order_date) {
        const issueDate = new Date(data.issue_date);
        const orderDate = new Date(data.order_date);
        return issueDate >= orderDate;
      }
      return true;
    },
    {
      message: "Дата выдачи не может быть раньше даты заказа",
      path: ["issue_date"],
    }
  );

// ============================================================================
// ORDER DETAIL SCHEMA
// ============================================================================

export const orderDetailSchema = z.object({
  // Required fields
  detail_number: z.number().int().positive("Номер детали должен быть > 0"),
  height: z.number().positive("Высота должна быть положительной"),
  width: z.number().positive("Ширина должна быть положительной"),
  quantity: z.number().int().positive("Количество должно быть > 0"),
  area: z.number().min(0, "Площадь должна быть >= 0"),

  // Materials and processing
  material_id: z.number().min(0, "Выберите материал"),
  milling_type_id: z.number().min(0, "Выберите тип фрезеровки"),
  edge_type_id: z.number().min(0, "Выберите тип кромки"),
  film_id: z.number().nullable().optional(),

  // Costs
  milling_cost_per_sqm: z.number().min(0, "Стоимость >= 0").nullable().optional(),
  detail_cost: z
    .number({
      required_error: "Сумма детали обязательна",
      invalid_type_error: "Сумма детали обязательна",
    })
    .min(0, "Стоимость >= 0"),

  // Additional
  note: z.string().max(1000, "Примечание не может превышать 1000 символов").nullable().optional(),
  detail_name: z.string().max(200, "Название не может превышать 200 символов").nullable().optional(),
  priority: z.number().int().min(0).max(100).default(100),
  production_status_id: z.number().nullable().optional(),
  joint_order_id: z.number().nullable().optional(),

  // File links
  link_cutting_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
  link_cutting_image_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
  link_cad_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),
  link_pdf_file: z.string().url("Некорректный URL").nullable().optional().or(z.literal('')),

  // System fields
  detail_id: z.number().optional(),
  order_id: z.number().optional(),
  delete_flag: z.boolean().optional(),
  version: z.number().int().optional(),
  ref_key_1c: z.string().nullable().optional(),
  created_by: z.number().optional(),
  edited_by: z.number().nullable().optional(),
  created_at: z.date().optional().or(z.string().optional()),
  updated_at: z.date().optional().or(z.string().optional()),
  temp_id: z.number().optional(),
});

// ============================================================================
// PAYMENT SCHEMA
// ============================================================================

export const paymentSchema = z.object({
  // Required fields
  amount: z.number().positive("Сумма платежа должна быть > 0"),
  payment_date: z
    .date()
    .max(new Date(), "Дата платежа не может быть в будущем")
    .or(z.string()),
  type_paid_id: z.number().positive("Выберите тип платежа"),

  // Optional
  notes: z.string().max(500, "Примечание не может превышать 500 символов").nullable().optional(),

  // System fields
  payment_id: z.number().optional(),
  order_id: z.number().optional(),
  ref_key_1c: z.string().nullable().optional(),
  created_by: z.number().optional(),
  edited_by: z.number().nullable().optional(),
  created_at: z.date().optional().or(z.string().optional()),
  updated_at: z.date().optional().or(z.string().optional()),
  temp_id: z.number().optional(),
});

// ============================================================================
// WORKSHOP SCHEMA
// ============================================================================

export const workshopSchema = z
  .object({
    // Required fields
    workshop_id: z.number().positive("Выберите цех"),
    production_status_id: z.number().positive("Выберите статус производства"),

    // Dates
    received_date: z.date().nullable().optional().or(z.string().nullable().optional()),
    started_date: z.date().nullable().optional().or(z.string().nullable().optional()),
    completed_date: z.date().nullable().optional().or(z.string().nullable().optional()),
    planned_completion_date: z.date().nullable().optional().or(z.string().nullable().optional()),

    // Additional
    sequence_order: z.number().int().nullable().optional(),
    notes: z.string().max(1000, "Примечание не может превышать 1000 символов").nullable().optional(),
    responsible_employee_id: z.number().nullable().optional(),

    // System fields
    order_workshop_id: z.number().optional(),
    order_id: z.number().optional(),
    delete_flag: z.boolean().optional(),
    ref_key_1c: z.string().nullable().optional(),
    created_by: z.number().optional(),
    edited_by: z.number().nullable().optional(),
    created_at: z.date().optional().or(z.string().optional()),
    updated_at: z.date().optional().or(z.string().optional()),
    temp_id: z.number().optional(),
  })
  .refine(
    (data) => {
      // Validation: completed_date >= started_date
      if (data.completed_date && data.started_date) {
        const completedDate = new Date(data.completed_date);
        const startedDate = new Date(data.started_date);
        return completedDate >= startedDate;
      }
      return true;
    },
    {
      message: "Дата завершения не может быть раньше даты начала",
      path: ["completed_date"],
    }
  );

// ============================================================================
// REQUIREMENT SCHEMA
// ============================================================================

export const requirementSchema = z.object({
  // Required fields
  resource_type: z.enum(['material', 'film', 'edge'], {
    errorMap: () => ({ message: "Выберите тип ресурса: material, film или edge" }),
  }),
  required_quantity: z.number().positive("Требуемое количество должно быть > 0"),
  unit_id: z.number().positive("Выберите единицу измерения"),
  requirement_status_id: z.number().positive("Выберите статус потребности"),

  // Resource IDs (depends on resource_type)
  material_id: z.number().nullable().optional(),
  film_id: z.number().nullable().optional(),
  edge_type_id: z.number().nullable().optional(),

  // Quantities
  waste_percentage: z.number().min(0, "Процент отходов >= 0").max(100, "Процент отходов <= 100").nullable().optional(),
  final_quantity: z.number().min(0, "Финальное количество >= 0").nullable().optional(),

  // Supplier and price
  supplier_id: z.number().nullable().optional(),
  purchase_price: z.number().min(0, "Цена >= 0").nullable().optional(),

  // Relations
  requisition_id: z.number().nullable().optional(),
  warehouse_id: z.number().nullable().optional(),

  // Timestamps
  reserved_at: z.date().nullable().optional().or(z.string().nullable().optional()),
  consumed_at: z.date().nullable().optional().or(z.string().nullable().optional()),

  // Additional
  notes: z.string().max(1000, "Примечание не может превышать 1000 символов").nullable().optional(),
  calculation_details: z.string().nullable().optional(),

  // System fields
  requirement_id: z.number().optional(),
  order_id: z.number().optional(),
  is_active: z.boolean().optional(),
  ref_key_1c: z.string().nullable().optional(),
  created_by: z.number().optional(),
  edited_by: z.number().nullable().optional(),
  created_at: z.date().optional().or(z.string().optional()),
  updated_at: z.date().optional().or(z.string().optional()),
  temp_id: z.number().optional(),
});

// ============================================================================
// FULL ORDER FORM SCHEMA
// ============================================================================

export const orderFormSchema = z
  .object({
    header: orderHeaderSchema,
    details: z.array(orderDetailSchema).min(1, "Необходимо добавить минимум одну позицию (деталь)"),
    payments: z.array(paymentSchema),
    workshops: z.array(workshopSchema),
    requirements: z.array(requirementSchema),

    // Deleted items (for tracking)
    deletedDetails: z.array(z.number()).optional(),
    deletedPayments: z.array(z.number()).optional(),
    deletedWorkshops: z.array(z.number()).optional(),
    deletedRequirements: z.array(z.number()).optional(),

    // Metadata
    isDirty: z.boolean().optional(),
    version: z.number().int().optional(),
  })
  .refine(
    (data) => {
      // Validation: Unique detail_number
      const detailNumbers = data.details.map((d) => d.detail_number);
      const uniqueNumbers = new Set(detailNumbers);
      return detailNumbers.length === uniqueNumbers.size;
    },
    {
      message: "Номера деталей должны быть уникальными",
      path: ["details"],
    }
  );

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type OrderHeaderInput = z.infer<typeof orderHeaderSchema>;
export type OrderDetailInput = z.infer<typeof orderDetailSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type WorkshopInput = z.infer<typeof workshopSchema>;
export type RequirementInput = z.infer<typeof requirementSchema>;
export type OrderFormInput = z.infer<typeof orderFormSchema>;
