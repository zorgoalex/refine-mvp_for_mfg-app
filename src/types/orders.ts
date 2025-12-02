// TypeScript types for Orders and related entities
// Based on PostgreSQL schema v11.6

// ============================================================================
// ORDERS (Header)
// ============================================================================

export interface Order {
  order_id?: number;
  order_name: string;
  client_id: number;
  order_date: Date | string;
  priority: number;

  // Dates
  completion_date?: Date | string | null;
  planned_completion_date?: Date | string | null;
  issue_date?: Date | string | null;

  // Statuses
  order_status_id: number;
  payment_status_id: number;

  // Financial fields
  total_amount?: number | null;
  discounted_amount?: number | null;
  discount: number;
  paid_amount: number;
  payment_date?: Date | string | null;

  // Aggregates (computed from order_details, read-only)
  parts_count?: number;
  total_area?: number;

  // Legacy fields (for compatibility)
  milling_type_id?: number | null;
  edge_type_id?: number | null;
  film_id?: number | null;
  material_id?: number | null;

  // File links
  link_cutting_file?: string | null;
  link_cutting_image_file?: string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;

  // Notes
  notes?: string | null;

  // Dowelling order (присадка) - linked 1:1
  doweling_order_id?: number | null;
  doweling_order_name?: string | null;
  design_engineer_id?: number | null;
  design_engineer?: string | null;

  // Management and audit
  manager_id?: number | null;
  delete_flag?: boolean;
  version?: number;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

// ============================================================================
// ORDER DETAILS
// ============================================================================

export interface OrderDetail {
  detail_id?: number;
  order_id?: number; // Will be set when saving
  detail_number: number;

  // Dimensions
  height: number;
  width: number;
  quantity: number;
  area: number; // Auto-calculated: height × width

  // Materials and processing
  material_id: number;
  milling_type_id: number;
  edge_type_id: number;
  film_id?: number | null;

  // Costs
  milling_cost_per_sqm?: number | null;
  detail_cost?: number | null;

  // Additional
  note?: string | null;
  detail_name?: string | null;
  priority: number;
  production_status_id?: number | null;
  joint_order_id?: number | null;

  // File links
  link_cutting_file?: string | null;
  link_cutting_image_file?: string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;

  // Management
  delete_flag?: boolean;
  version?: number;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Client-side only (for new records)
  temp_id?: number;
}

// ============================================================================
// PAYMENTS
// ============================================================================

export interface Payment {
  payment_id?: number;
  order_id?: number; // Will be set when saving
  type_paid_id: number;
  amount: number;
  payment_date: Date | string;
  notes?: string | null;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Client-side only
  temp_id?: number;
}

// ============================================================================
// ORDER WORKSHOPS
// ============================================================================

export interface OrderWorkshop {
  order_workshop_id?: number;
  order_id?: number; // Will be set when saving
  workshop_id: number;
  production_status_id: number;

  // Dates
  received_date?: Date | string | null;
  started_date?: Date | string | null;
  completed_date?: Date | string | null;
  planned_completion_date?: Date | string | null;

  sequence_order?: number | null;
  notes?: string | null;
  responsible_employee_id?: number | null;
  delete_flag?: boolean;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Client-side only
  temp_id?: number;
}

// ============================================================================
// ORDER RESOURCE REQUIREMENTS
// ============================================================================

export interface OrderResourceRequirement {
  requirement_id?: number;
  order_id?: number; // Will be set when saving
  resource_type: 'material' | 'film' | 'edge' | string;

  // Resource IDs (depends on resource_type)
  material_id?: number | null;
  film_id?: number | null;
  edge_type_id?: number | null;

  // Quantities
  required_quantity: number;
  unit_id: number;
  waste_percentage?: number | null;
  final_quantity?: number | null;

  // Status and supplier
  requirement_status_id: number;
  supplier_id?: number | null;
  purchase_price?: number | null;

  // Relations
  requisition_id?: number | null;
  warehouse_id?: number | null;

  // Timestamps
  reserved_at?: Date | string | null;
  consumed_at?: Date | string | null;

  notes?: string | null;
  calculation_details?: string | null;
  is_active?: boolean;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Client-side only
  temp_id?: number;
}

// ============================================================================
// FORM VALUES (Combined type for the entire order form)
// ============================================================================

export interface OrderFormValues {
  // Header
  header: Order;

  // Child tables
  details: OrderDetail[];
  payments: Payment[];
  workshops: OrderWorkshop[];
  requirements: OrderResourceRequirement[];

  // Deleted items (track for deletion on server)
  deletedDetails?: number[];
  deletedPayments?: number[];
  deletedWorkshops?: number[];
  deletedRequirements?: number[];

  // Form metadata
  isDirty?: boolean;
  version?: number;
}

// ============================================================================
// COMPUTED TOTALS
// ============================================================================

export interface OrderTotals {
  positions_count: number; // Количество позиций (записей деталей)
  parts_count: number; // Количество деталей (сумма quantity)
  total_area: number;
  total_paid: number;
  total_amount: number; // Сумма всех detail_cost
}

// ============================================================================
// FORM MODE
// ============================================================================

export type OrderFormMode = 'create' | 'edit';

// ============================================================================
// VALIDATION ERROR
// ============================================================================

export interface OrderValidationError {
  field: string;
  message: string;
  section?: 'header' | 'details' | 'payments' | 'workshops' | 'requirements';
  index?: number; // For array items
}
