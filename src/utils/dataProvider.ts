// Minimal Hasura GraphQL data provider for Refine (MVP)
// Implements: getList, getOne, create, update, deleteOne

import { authStorage, isTokenExpired, refreshAccessToken } from './auth';
import { logGraphQLError } from './notificationLogger';
import { clientPhonesApi } from '../api/clientPhonesApi';
import { ordersApi } from '../api/ordersApi';
import { paymentsApi } from '../api/paymentsApi';
import { usersApi } from '../api/usersApi';
import { mapOrderDtoToFormValues, mapOrderListItemToLegacyRow } from '../api/mappers/orderMapper';
import type { OrderListQuery, OrderSortBy, SortOrder } from '../api/types/orderApi.types';
import type { ClientPhoneDto } from '../api/types/clientPhoneApi.types';
import type { PaymentDto } from '../api/types/paymentApi.types';
import type { UserDto, UserListQuery } from '../api/types/userApi.types';
import type { UserRole } from '../api/types/authApi.types';
import { featureFlags } from '../config/featureFlags';

type AnyObject = Record<string, any>;

const HASURA_URL = (import.meta as any).env.VITE_HASURA_GRAPHQL_URL as string;

const ID_COLUMNS: Record<string, string> = {
  orders_view: "order_id",
  orders: "order_id",
  order_details_view: "detail_id",
  doweling_orders_view: "doweling_order_id",
  doweling_orders: "doweling_order_id",
  order_doweling_links: "order_doweling_link_id",
  clients_analytics_view: "client_id",
  payments_view: "payment_id",
  materials: "material_id",
  material_types: "material_type_id",
  vendors: "vendor_id",
  suppliers: "supplier_id",
  milling_types: "milling_type_id",
  films: "film_id",
  clients: "client_id",
  film_types: "film_type_id",
  edge_types: "edge_type_id",
  order_statuses: "order_status_id",
  payment_statuses: "payment_status_id",
  payment_types: "type_paid_id",
  // New resources from schema v11.4:
  units: "unit_id",
  roles: "role_id",
  employees: "employee_id",
  users: "user_id",
  workshops: "workshop_id",
  work_centers: "workcenter_id",
  requisition_statuses: "requisition_status_id",
  movements_statuses: "movement_status_id",
  material_transaction_types: "transaction_type_id",
  transaction_direction: "direction_type_id",
  production_statuses: "production_status_id",
  production_status_events: "event_id",
  resource_requirements_statuses: "requirement_status_id",
  order_workshops: "order_workshop_id",
  order_resource_requirements: "requirement_id",
  order_details: "detail_id",
  payments: "payment_id",
  client_phones: "phone_id",
  app_settings: "setting_id",
  // VLM configuration tables
  vlm_providers: "provider_id",
  vlm_provider_models: "provider_model_id",
  vlm_prompts: "prompt_id",
  sheet_material_types: "sheet_material_type_id",
};

// Resources with is_active field - automatically filter by is_active = true in getList
const ACTIVE_FILTERED_RESOURCES = [
  // Reference tables (справочники)
  // NOTE: "units" does NOT have is_active field in schema v11.5
  "clients",
  "edge_types",
  "film_types",
  "films",
  "materials",
  "material_types",
  "vendors",
  "suppliers",
  "milling_types",
  "payment_types",
  "payment_statuses",
  "order_statuses",
  // Logistics & statuses (логистика и статусы)
  "requisition_statuses",
  "movements_statuses",
  "material_transaction_types",
  "transaction_direction",
  // Production resources (производственные ресурсы)
  "employees",
  "users",
  "workshops",
  "work_centers",
  "production_statuses",
  "resource_requirements_statuses",
  "app_settings",
  // VLM configuration tables
  "vlm_providers",
  "vlm_provider_models",
  "vlm_prompts",
  "sheet_material_types",
];

const RESOURCE_FIELDS: Record<string, string[]> = {
  // Read-only aggregate view
  orders_view: [
    "order_id",
    "order_name",
    "order_name_numeric",
    "client_id",
    "client_name",
    "order_date",
    "priority",
    "doweling_order_id",
    "doweling_order_name",
    "design_engineer",
    "completion_date",
    "planned_completion_date",
    "order_status_name",
    "payment_status_name",
    "production_status_name",
    "issue_date",
    "total_amount",
    "final_amount",
    "discount",
    "surcharge",
    "paid_amount",
    "payment_date",
    "parts_count",
    "total_area",
    "milling_type_name",
    "edge_type_name",
    "film_name",
    "material_name",
    "sheet_material_type_id",
    "link_cutting_file",
    "link_cutting_image_file",
    "notes",
    "order_ref_key_1c",
    "client_ref_key_1c",
    "manager_id",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
    "version",
  ],
  // Base orders table (for edit)
  orders: [
    "order_id",
    "order_name",
    "order_date",
    "client_id",
    "manager_id",
    "order_status_id",
    "payment_status_id",
    "priority",
    "planned_completion_date",
    "completion_date",
    "issue_date",
    "total_amount",
    "discount",
    "surcharge",
    "final_amount",
    "paid_amount",
    "payment_date",
    "parts_count",
    "total_area",
    // Legacy fields
    "material_id",
    // SP3: order-header sheet material + durable SP3-era marker
    "sheet_material_type_id",
    "sheet_eligible",
    "milling_type_id",
    "edge_type_id",
    "film_id",
    // File links
    "link_cutting_file",
    "link_cutting_image_file",
    "link_cad_file",
    "link_pdf_file",
    // Notes
    "notes",
    // Reference key
    "ref_key_1c",
    // Audit fields
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
    "version",
    // Relationship: doweling links (many-to-many)
    "order_doweling_links { order_doweling_link_id order_id doweling_order_id doweling_order { doweling_order_id doweling_order_name design_engineer_id } }",
  ],
  materials: [
    "material_id",
    "material_name",
    "unit_id",
    "unit { unit_id unit_code unit_name unit_symbol }",
    "material_type_id",
    "material_type { material_type_id material_type_name }",
    "vendor_id",
    "vendor { vendor_id vendor_name }",
    "default_supplier_id",
    "default_supplier { supplier_id supplier_name }",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  material_types: [
    "material_type_id",
    "material_type_name",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  
  milling_types: [
    "milling_type_id",
    "milling_type_name",
    "cost_per_sqm",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  films: [
    "film_id",
    "film_name",
    "film_type_id",
    "vendor_id",
    "film_texture",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  clients: [
    "client_id",
    "client_name",
    "ref_key_1c",
    "is_active",
    "notes",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  client_phones: [
    "phone_id",
    "client_id",
    "phone_number",
    "phone_type",
    "is_primary",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  app_settings: [
    "setting_id",
    "setting_key",
    "value_json",
    "description",
    "is_active",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  // VLM configuration tables
  vlm_providers: [
    "provider_id",
    "sort_order",
    "name",
    "priority",
    "is_active",
    "is_default",
    "notes",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  vlm_provider_models: [
    "provider_model_id",
    "provider_id",
    "sort_order",
    "name",
    "priority",
    "is_active",
    "is_default",
    "thinking",
    "total_context",
    "max_output",
    "input_price",
    "output_price",
    "cache_read",
    "cache_write",
    "sys_prompt",
    "input_modalities",
    "output_modalities",
    "notes",
    "vlm_provider { provider_id name is_active is_default }",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  vlm_prompts: [
    "prompt_id",
    "namespace",
    "name",
    "version",
    "lang",
    "tags",
    "priority",
    "is_active",
    "is_default",
    "notes",
    "prompt_id_deno",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  sheet_material_types: [
    "sheet_material_type_id", "name",
    "material_type_id", "material_type { material_type_id material_type_name }",
    "unit_id", "unit { unit_id unit_code unit_name unit_symbol }",
    "supplier_id", "supplier { supplier_id supplier_name }",
    "vendor_id", "vendor { vendor_id vendor_name }",
    "supplier_article", "texture", "color",
    "thickness_mm", "width_mm", "height_mm",
    "is_active", "version", "ref_key_1c",
    "created_by", "edited_by", "created_at", "updated_at",
  ],
  film_types: [
    "film_type_id",
    "film_type_name",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  edge_types: [
    "edge_type_id",
    "edge_type_name",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  vendors: [
    "vendor_id",
    "vendor_name",
    "contact_info",
    "material_type_id",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  suppliers: [
    "supplier_id",
    "supplier_name",
    "address",
    "contact_person",
    "phone",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  order_statuses: [
    "order_status_id",
    "order_status_name",
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  payment_statuses: [
    "payment_status_id",
    "payment_status_name",
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  payment_types: [
    "type_paid_id",
    "type_paid_name",
    "sort_order",
    "is_active",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  // New resources from schema v11.4:
  units: [
    "unit_id",
    "unit_code",
    "unit_name",
    "unit_symbol",
    "decimals",
    "ref_key_1c",
  ],
  roles: [
    "role_id",
    "role_name",
    "role_description",
    "is_active",
    "ref_key_1c",
  ],
  employees: [
    "employee_id",
    "position",
    "full_name",
    "note",
    "is_active",
    "ref_key_1c",
  ],
  users: [
    "user_id",
    "username",
    "role_id",
    "role { role_id role_name }",
    "employee_id",
    "employee { employee_id full_name }",
    "is_active",
    "last_login_at",
    "ref_key_1c",
  ],
  workshops: [
    "workshop_id",
    "workshop_name",
    "address",
    "responsible_employee_id",
    "employee { employee_id full_name }",
    "is_active",
    "ref_key_1c",
  ],
  work_centers: [
    "workcenter_id",
    "workcenter_code",
    "workcenter_name",
    "workshop_id",
    "workshop { workshop_id workshop_name }",
    "is_active",
    "ref_key_1c",
  ],
  requisition_statuses: [
    "requisition_status_id",
    "requisition_status_name",
    "sort_order",
    "is_active",
    "description",
  ],
  movements_statuses: [
    "movement_status_id",
    "movement_status_code",
    "movement_status_name",
    "sort_order",
    "is_active",
    "description",
  ],
  material_transaction_types: [
    "transaction_type_id",
    "transaction_type_name",
    "direction_type_id",
    "direction { direction_type_id direction_code direction_name }",
    "affects_stock",
    "requires_document",
    "sort_order",
    "is_active",
    "description",
  ],
  transaction_direction: [
    "direction_type_id",
    "direction_code",
    "direction_name",
    "description",
    "is_active",
  ],
  production_statuses: [
    "production_status_id",
    "production_status_name",
    "production_status_code",
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  production_status_events: [
    "event_id",
    "order_id",
    "detail_id",
    "production_status_id",
    "event_at",
    "event_by",
    "note",
    "payload",
  ],
  resource_requirements_statuses: [
    "requirement_status_id",
    "requirement_status_code",
    "requirement_status_name",
    "sort_order",
    "is_active",
    "description",
    "ref_key_1c",
  ],
  order_workshops: [
    "order_workshop_id",
    "order_id",
    "workshop_id",
    "production_status_id",
    "received_date",
    "started_date",
    "completed_date",
    "planned_completion_date",
    "sequence_order",
    "notes",
    "responsible_employee_id",
    "delete_flag",
    "ref_key_1c",
  ],
  order_resource_requirements: [
    "requirement_id",
    "order_id",
    "resource_type",
    "material_id",
    "film_id",
    "edge_type_id",
    "required_quantity",
    "unit_id",
    "waste_percentage",
    "final_quantity",
    "requirement_status_id",
    "supplier_id",
    "purchase_price",
    "requisition_id",
    "warehouse_id",
    "reserved_at",
    "consumed_at",
    "notes",
    "calculation_details",
    "is_active",
    "ref_key_1c",
  ],
  order_details: [
    "detail_id",
    "order_id",
    "detail_number",
    "height",
    "width",
    "quantity",
    "area",
    "material_id",
    "sheet_material_type_id",
    "milling_type_id",
    "edge_type_id",
    "film_id",
    "milling_cost_per_sqm",
    "detail_cost",
    "note",
    "detail_name",
    "priority",
    "production_status_id",
    "joint_order_id",
    "link_cutting_file",
    "link_cutting_image_file",
    "link_cad_file",
    "link_pdf_file",
    "delete_flag",
    "version",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  // SP3 read-only view: per-detail server-resolved material_name =
  // COALESCE(sheet name, material name). Display reads from here so it never
  // needs sheet_materials.view nor a (hidden) shadow materials row.
  order_details_view: [
    "detail_id",
    "order_id",
    "detail_number",
    "detail_name",
    "height",
    "width",
    "quantity",
    "area",
    "material_id",
    "sheet_material_type_id",
    "material_name",
    "milling_type_id",
    "edge_type_id",
    "film_id",
    "milling_cost_per_sqm",
    "detail_cost",
    "priority",
    "production_status_id",
    "joint_order_id",
    "note",
    "link_cutting_file",
    "link_cutting_image_file",
    "link_cad_file",
    "link_pdf_file",
    "ref_key_1c",
  ],
  payments: [
    "payment_id",
    "order_id",
    "type_paid_id",
    "amount",
    "payment_date",
    "notes",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  // Doweling orders (присадка)
  doweling_orders_view: [
    "doweling_order_id",
    "doweling_order_name",
    "order_id",
    "order_name",
    "client_id",
    "client_name",
    "doweling_order_date",
    "payment_status_name",
    "production_status_name",
    "issue_date",
    "total_amount",
    "final_amount",
    "discount",
    "paid_amount",
    "payment_date",
    "parts_count",
    "milling_type_name",
    "edge_type_name",
    "material_name",
    "design_engineer_id",
    "design_engineer",
    "operator_id",
    "operator",
    "link_cad_file",
    "link_pdf_file",
    "version",
    "order_ref_key_1c",
    "client_ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  doweling_orders: [
    "doweling_order_id",
    "doweling_order_name",
    "doweling_order_date",
    "order_id",
    "payment_status_id",
    "production_status_id",
    "issue_date",
    "total_amount",
    "final_amount",
    "discount",
    "paid_amount",
    "payment_date",
    "parts_count",
    "design_engineer_id",
    "operator_id",
    "link_cad_file",
    "link_pdf_file",
    "delete_flag",
    "version",
    "ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  order_doweling_links: [
    "order_doweling_link_id",
    "order_id",
    "doweling_order_id",
    "doweling_order { doweling_order_id doweling_order_name design_engineer_id operator_id payment_status_id production_status_id doweling_order_date parts_count total_amount final_amount discount paid_amount payment_date issue_date }",
    "order { order_id order_name client_id }",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
  ],
  // Clients analytics view (агрегированные данные по клиентам)
  clients_analytics_view: [
    "client_id",
    "client_name",
    "primary_phone",
    "all_phones",
    "is_active",
    "notes",
    "orders_total_count",
    "orders_in_progress_count",
    "orders_completed_count",
    "first_order_date",
    "last_order_date",
    "total_amount_sum",
    "final_amount_sum",
    "discount_sum",
    "surcharge_sum",
    "paid_amount_sum",
    "debt_sum",
    "parts_count_sum",
    "total_area_sum",
    "payments_count",
    "payments_total",
    "last_payment_date",
    "last_order_id",
    "last_order_name",
    "last_order_date_exact",
    "last_order_status_name",
    "last_payment_status_name",
    "last_order_total_amount",
    "last_order_final_amount",
    "last_order_paid_amount",
    "has_debt",
    "days_since_last_order",
    "created_at",
    "updated_at",
    "ref_key_1c",
    "created_by",
    "edited_by",
  ],
  // Payments analytics view (агрегированные данные по платежам)
  payments_view: [
    "payment_id",
    "order_id",
    "amount",
    "payment_date",
    "type_paid_id",
    "type_paid_name",
    "notes",
    "order_name",
    "order_date",
    "priority",
    "completion_date",
    "planned_completion_date",
    "issue_date",
    "client_id",
    "client_name",
    "total_amount",
    "final_amount",
    "discount",
    "surcharge",
    "order_paid_amount_field",
    "order_effective_final_amount",
    "total_payments_for_order",
    "cumulative_payment_for_order",
    "payment_sequence_number",
    "order_balance_total",
    "order_balance_after_this_payment",
    "paid_amount_mismatch",
    "order_status_id",
    "order_status_name",
    "payment_status_id",
    "payment_status_name",
    "production_status_id",
    "production_status_name",
    "delete_flag",
    "version",
    "payment_ref_key_1c",
    "created_by",
    "edited_by",
    "created_at",
    "updated_at",
    "order_ref_key_1c",
    "client_ref_key_1c",
  ],
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  film_vendors: ["film_vendor_name"],
  film_types: ["film_type_name"],
  doweling_orders: ["doweling_order_name", "payment_status_id", "design_engineer_id", "operator_id"],
  material_types: ["material_type_name"],
  vendors: ["vendor_name"],
  edge_types: ["edge_type_name"],
  order_statuses: ["order_status_name"],
  payment_statuses: ["payment_status_name"],
  payment_types: ["type_paid_name"],
  suppliers: ["supplier_name"],
  // New resources from schema v11.4:
  units: ["unit_code", "unit_name"],
  employees: ["position", "full_name"],
  users: ["username"],
  order_details: ["order_id", "detail_number", "height", "width", "quantity", "area", "material_id", "milling_type_id", "edge_type_id"],
  payments: ["order_id", "type_paid_id", "amount", "payment_date"],
  workshops: ["workshop_name"],
  work_centers: ["workcenter_code", "workcenter_name"],
  requisition_statuses: ["requisition_status_name"],
  movements_statuses: ["movement_status_code", "movement_status_name"],
  material_transaction_types: ["transaction_type_name"],
  transaction_direction: ["direction_code", "direction_name"],
  production_statuses: ["production_status_name"],
  resource_requirements_statuses: ["requirement_status_code", "requirement_status_name"],
  order_workshops: ["order_id", "workshop_id", "production_status_id"],
  order_resource_requirements: ["order_id", "resource_type", "required_quantity", "unit_id", "requirement_status_id"],
};

// Temporary workaround for tables where PK has NOT NULL without default/identity in the actual DB
// Generates a BIGINT ID on the client if not provided
// NOTE: schema v11.4 has IDENTITY for all tables, so this is no longer needed
const FORCE_PK_ON_INSERT: Record<string, boolean> = {
  // film_vendors: true,  // REMOVED: now has IDENTITY in schema v11.4
};

/**
 * Создает заголовки для GraphQL запросов
 * Автоматически добавляет JWT токен из localStorage
 * Обновляет токен если он истек
 */
const headers = async () => {
  let token = authStorage.getAccessToken();

  // Проверить и обновить токен если истек
  if (token && isTokenExpired(token)) {
    const newToken = await refreshAccessToken();
    token = newToken || token;
  }

  return {
    "Content-Type": "application/json",
    ...(token && { "Authorization": `Bearer ${token}` }),
  };
};

// Helper to parse error messages into user-friendly text
const parsePostgresError = (message: string): string => {
  // Authentication errors from Hasura
  if (message.includes('Missing') && message.includes('Authorization')) {
    return 'Сессия истекла. Пожалуйста, войдите в систему заново.';
  }
  if (message.includes('JWT') && message.includes('authentication')) {
    return 'Сессия истекла. Пожалуйста, войдите в систему заново.';
  }
  if (message.includes('Could not verify JWT')) {
    return 'Ошибка авторизации. Пожалуйста, войдите в систему заново.';
  }

  // Unique constraint violations
  if (message.includes('duplicate key value violates unique constraint')) {
    const constraintMatch = message.match(/constraint "(.+?)"/);
    const constraint = constraintMatch ? constraintMatch[1] : 'unique constraint';

    // Parse constraint name to field name
    if (constraint.includes('_name')) {
      return 'Это название уже существует. Пожалуйста, используйте другое.';
    }
    if (constraint.includes('_code')) {
      return 'Этот код уже существует. Пожалуйста, используйте другой.';
    }
    if (constraint.includes('sort_order')) {
      return 'Порядок сортировки должен быть уникальным. Это значение уже используется.';
    }
    return `Значение должно быть уникальным (${constraint})`;
  }

  // NOT NULL violations
  if (message.includes('null value in column') && message.includes('violates not-null constraint')) {
    const columnMatch = message.match(/column "(.+?)"/);
    const column = columnMatch ? columnMatch[1] : 'поле';
    return `Поле "${column}" обязательно для заполнения`;
  }

  // Foreign key violations
  if (message.includes('violates foreign key constraint')) {
    return 'Невозможно удалить запись, так как она используется в других таблицах';
  }

  // Check constraint violations
  if (message.includes('violates check constraint')) {
    const constraintMatch = message.match(/constraint "(.+?)"/);
    const constraint = constraintMatch ? constraintMatch[1] : '';
    if (constraint.includes('positive') || constraint.includes('non_negative')) {
      return 'Значение должно быть положительным числом';
    }
    return 'Значение не соответствует требованиям валидации';
  }

  // Default: return original message
  return message;
};

const gqlRequest = async (query: string): Promise<any> => {
  const res = await fetch(HASURA_URL, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ query }),
  });
  const json = await res.json();

  if (!res.ok || json.errors) {
    const rawMessage = json?.errors?.[0]?.message || res.statusText;
    const message = parsePostgresError(rawMessage);
    const statusCode = !res.ok ? res.status : 400;

    // Логируем ошибку в систему уведомлений
    logGraphQLError({ message, statusCode }, 'GraphQL запрос');

    throw { message, statusCode };
  }

  return json.data;
};

const escapeValue = (v: any) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // ISO for Date
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  return JSON.stringify(v);
};

const sanitizeVariables = (input: AnyObject) => {
  const out: AnyObject = {};

  // Keys that should be treated as numeric even if provided as strings
  // (explicit whitelist to avoid breaking string fields like order_name/unit_code)
  const NUMERIC_FIELDS = new Set([
    // common numbers
    "quantity",
    "height",
    "width",
    "area",
    "priority",
    "discount",
    "final_amount",
    "total_amount",
    "paid_amount",
    "amount",
    "payment_amount",
    "milling_cost_per_sqm",
    "detail_cost",
    "purchase_price",
    "required_quantity",
    "waste_percentage",
    "final_quantity",
    "sequence_order",
    "sort_order",
    "decimals",
    "version",
  ]);

  // Keys that should remain strings even if they look numeric
  const FORCE_STRING_FIELDS = new Set([
    "password_hash",
    "ref_key_1c",
    "order_name",
    "unit_code",
    "unit_name",
    "direction_code",
  ]);

  // Heuristics for string-like keys
  const isStringLikeKey = (key: string) =>
    /(_name|_code|^link_|notes?$|description|address|contact|_file|_ref)/i.test(key) ||
    FORCE_STRING_FIELDS.has(key);

  // Heuristics for numeric-like keys
  const isNumericLikeKey = (key: string) => key.endsWith("_id") || NUMERIC_FIELDS.has(key);

  const isNumericString = (val: string) => /^\d+(?:\.\d+)?$/.test(val);

  for (const [k, v] of Object.entries(input || {})) {
    if (v === "") {
      out[k] = null;
      continue;
    }

    if (typeof v === "string") {
      if (isStringLikeKey(k)) {
        out[k] = v; // keep as string
        continue;
      }
      if (isNumericLikeKey(k) && isNumericString(v)) {
        out[k] = Number(v);
        continue;
      }
      out[k] = v; // default: keep as string
      continue;
    }

    out[k] = v;
  }
  return out;
};

const buildOrderBy = (resource: string, sorters?: any[]) => {
  if (!sorters || sorters.length === 0) return "";
  const parts = sorters.map((s) => `{ ${s.field}: ${s.order === "desc" ? "desc" : "asc"} }`);
  return `, order_by: [${parts.join(", ")}]`;
};

const mapOperator = (op: string) => {
  switch (op) {
    case "eq":
      return "_eq";
    case "ne":
      return "_neq";
    case "lt":
      return "_lt";
    case "lte":
      return "_lte";
    case "gt":
      return "_gt";
    case "gte":
      return "_gte";
    case "contains":
      return "_ilike";
    case "startswith":
      return "_ilike";
    case "endswith":
      return "_ilike";
    case "in":
      return "_in";
    default:
      return "_eq";
  }
};

const normalizeContains = (op: string, value: any) => {
  if (op === "contains") return `%${value}%`;
  if (op === "startswith") return `${value}%`;
  if (op === "endswith") return `%${value}`;
  return value;
};

const buildWhere = (filters?: any[]) => {
  if (!filters || filters.length === 0) return "";
  const andParts = filters.map((f) => {
    const op = mapOperator(f.operator);
    const val = normalizeContains(f.operator, f.value);
    return `{ ${f.field}: { ${op}: ${escapeValue(val)} } }`;
  });
  return `, where: { _and: [${andParts.join(", ")}] }`;
};

const ORDER_SORT_FIELD_MAP: Record<string, OrderSortBy> = {
  order_id: 'orderId',
  order_name: 'orderName',
  order_date: 'orderDate',
  planned_completion_date: 'plannedCompletionDate',
  completion_date: 'completionDate',
  issue_date: 'issueDate',
  client_name: 'clientName',
  order_status_name: 'orderStatusName',
  payment_status_name: 'paymentStatusName',
  production_status_name: 'productionStatusName',
  final_amount: 'finalAmount',
  paid_amount: 'paidAmount',
  debt_amount: 'debtAmount',
  updated_at: 'updatedAt',
};

const USER_ROLE_ID_MAP: Record<number, UserRole> = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  100: 'viewer',
};

const USER_ROLE_LABELS: Record<UserRole, string> = {
  superadmin: 'Суперадминистратор',
  admin: 'Администратор',
  top_manager: 'Топ-менеджер',
  manager: 'Менеджер',
  operator: 'Оператор',
  worker: 'Работник',
  viewer: 'Наблюдатель',
};

function mapOrdersViewQueryToBackend(
  pagination?: AnyObject,
  sorters?: AnyObject[],
  filters?: AnyObject[],
): OrderListQuery | null {
  const query: OrderListQuery = {
    page: pagination?.current ?? 1,
    pageSize: pagination?.pageSize ?? 10,
  };

  const sorter = sorters?.find((item) => ORDER_SORT_FIELD_MAP[item.field]);
  if (sorter) {
    query.sortBy = ORDER_SORT_FIELD_MAP[sorter.field];
    query.sortOrder = (sorter.order === 'asc' ? 'asc' : 'desc') as SortOrder;
  }

  const currentUser = authStorage.getUser();

  for (const filter of filters ?? []) {
    const field = filter.field;
    const value = filter.value;
    if (value === null || value === undefined || value === '') continue;

    switch (field) {
      case 'order_name':
        query.search = String(value);
        break;
      case 'client_id':
        query.clientId = Number(value);
        break;
      case 'order_status_id':
        query.orderStatusId = Number(value);
        break;
      case 'payment_status_id':
        query.paymentStatusId = Number(value);
        break;
      case 'production_status_id':
        query.productionStatusId = Number(value);
        break;
      case 'order_date':
        if (filter.operator === 'gte') {
          query.dateFrom = String(value);
          break;
        }
        if (filter.operator === 'lte') {
          query.dateTo = String(value);
          break;
        }
        return null;
      case 'created_by':
        if (currentUser?.id && Number(value) === Number(currentUser.id)) {
          query.onlyMyOrders = true;
          break;
        }
        return null;
      case 'project_ids': {
        const projectIds = Array.isArray(value) ? value.map(String) : String(value).split(',');
        query.projectIds = projectIds.map((item) => item.trim()).filter(Boolean);
        break;
      }
      case 'project_mode':
        if (value === 'any' || value === 'all' || value === 'primary' || value === 'none') {
          query.projectMode = value;
          break;
        }
        return null;
      default:
        return null;
    }
  }

  return query;
}

async function getBackendOrdersListIfEnabled(
  resource: string,
  pagination?: AnyObject,
  sorters?: AnyObject[],
  filters?: AnyObject[],
) {
  if (!featureFlags.useBackendOrdersRead || resource !== 'orders_view') {
    return null;
  }

  const query = mapOrdersViewQueryToBackend(pagination, sorters, filters);
  if (!query) {
    return null;
  }

  const response = await ordersApi.list(query);
  return {
    data: response.data.map(mapOrderListItemToLegacyRow),
    total: response.pagination.total,
  };
}

async function getBackendOrderOneIfEnabled(resource: string, id: number | string) {
  if (!featureFlags.useBackendOrdersRead || (resource !== 'orders_view' && resource !== 'orders')) {
    return null;
  }

  const order = await ordersApi.getById(Number(id));
  const formValues = mapOrderDtoToFormValues(order);
  return {
    data: {
      ...formValues.header,
      __backendOrder: formValues,
    },
  };
}

function mapUsersQueryToBackend(
  pagination?: AnyObject,
  filters?: AnyObject[],
): UserListQuery {
  const query: UserListQuery = {
    page: pagination?.current ?? 1,
    pageSize: pagination?.pageSize ?? 10,
  };

  for (const filter of filters ?? []) {
    const field = filter.field;
    const value = filter.value;
    if (value === null || value === undefined || value === '') continue;

    switch (field) {
      case 'username':
      case 'email':
      case 'full_name':
        query.search = String(value);
        break;
      case 'role':
        if (isUserRole(value)) {
          query.role = value;
        }
        break;
      case 'role_id': {
        const role = USER_ROLE_ID_MAP[Number(value)];
        if (role) {
          query.role = role;
        }
        break;
      }
      case 'is_active':
        query.isActive = parseBooleanFilter(value);
        break;
      default:
        break;
    }
  }

  return query;
}

async function getBackendUsersListIfEnabled(
  resource: string,
  pagination?: AnyObject,
  filters?: AnyObject[],
) {
  if (!featureFlags.useBackendUsers || resource !== 'users') {
    return null;
  }

  const response = await usersApi.list(mapUsersQueryToBackend(pagination, filters));
  return {
    data: response.data.map(mapBackendUserToLegacyRow),
    total: response.pagination.total,
  };
}

async function getBackendUserOneIfEnabled(resource: string, id: number | string) {
  if (!featureFlags.useBackendUsers || resource !== 'users') {
    return null;
  }

  const user = await usersApi.getById(Number(id));
  return {
    data: mapBackendUserToLegacyRow(user),
  };
}

async function getBackendUsersManyIfEnabled(resource: string, ids: Array<number | string>) {
  if (!featureFlags.useBackendUsers || resource !== 'users') {
    return null;
  }

  const users = await Promise.all(ids.map((id) => usersApi.getById(Number(id))));
  return {
    data: users.map(mapBackendUserToLegacyRow),
  };
}

async function createBackendPaymentIfEnabled(resource: string, variables?: AnyObject, _meta?: AnyObject) {
  if (!shouldUseBackendPaymentMutation(resource)) {
    return null;
  }

  const payment = await paymentsApi.create(mapLegacyPaymentCreateVariablesToBackend(variables));
  return { data: mapBackendPaymentToLegacyRow(payment) };
}

async function createBackendClientPhoneIfEnabled(resource: string, variables?: AnyObject) {
  if (!shouldUseBackendClientPhoneMutation(resource)) {
    return null;
  }

  const phone = await clientPhonesApi.create(mapLegacyClientPhoneCreateVariablesToBackend(variables));
  return { data: mapBackendClientPhoneToLegacyRow(phone) };
}

async function updateBackendClientPhoneIfEnabled(
  resource: string,
  id: number | string,
  variables?: AnyObject,
) {
  if (!shouldUseBackendClientPhoneMutation(resource)) {
    return null;
  }

  const phone = await clientPhonesApi.update(
    Number(id),
    mapLegacyClientPhoneUpdateVariablesToBackend(variables),
  );
  return { data: mapBackendClientPhoneToLegacyRow(phone) };
}

async function deleteBackendClientPhoneIfEnabled(resource: string, id: number | string) {
  if (!shouldUseBackendClientPhoneMutation(resource)) {
    return null;
  }

  const response = await clientPhonesApi.delete(Number(id));
  return { data: { phone_id: response.phoneId } };
}

async function updateBackendPaymentIfEnabled(
  resource: string,
  id: number | string,
  variables?: AnyObject,
  _meta?: AnyObject,
) {
  if (!shouldUseBackendPaymentMutation(resource)) {
    return null;
  }

  const payment = await paymentsApi.update(Number(id), mapLegacyPaymentUpdateVariablesToBackend(variables));
  return { data: mapBackendPaymentToLegacyRow(payment) };
}

async function deleteBackendPaymentIfEnabled(resource: string, id: number | string, _meta?: AnyObject) {
  if (!shouldUseBackendPaymentMutation(resource)) {
    return null;
  }

  const response = await paymentsApi.delete(Number(id));
  return { data: { payment_id: response.paymentId } };
}

async function deleteBackendOrderIfEnabled(resource: string, id: number | string, meta?: AnyObject) {
  if (!shouldUseBackendOrderMutation(resource)) {
    return null;
  }

  const response = await ordersApi.delete(Number(id), {
    version: requireOrderDeleteVersion(meta),
    idempotencyKey: optionalString(meta?.idempotencyKey),
  });
  return { data: { order_id: response.orderId } };
}

function shouldUseBackendOrderMutation(resource: string): boolean {
  return featureFlags.useBackendOrdersWrite && resource === 'orders';
}

function shouldUseBackendPaymentMutation(resource: string): boolean {
  return featureFlags.useBackendPayments && resource === 'payments';
}

function shouldUseBackendClientPhoneMutation(resource: string): boolean {
  return featureFlags.useBackendClientPhones && resource === 'client_phones';
}

// Resources whose writes are owned exclusively by the backend command API. The
// generic Hasura mutation path must never be reachable for these (defense in
// depth on top of Hasura select-only perms): all writes go through the dedicated
// backend client (e.g. sheetMaterialsApi -> /api/v1/sheet-material-types), which
// enforces RBAC, audit, optimistic version and the feature flag.
const BACKEND_ONLY_WRITE_RESOURCES = new Set<string>(['sheet_material_types']);

function assertNotBackendOnlyWrite(resource: string): void {
  if (BACKEND_ONLY_WRITE_RESOURCES.has(resource)) {
    throw {
      message: `${resource} is written only through the backend API; Hasura writes are disabled`,
      statusCode: 403,
    };
  }
}

function requireOrderDeleteVersion(meta?: AnyObject): number {
  const version = meta?.version ?? meta?.orderVersion;

  if (!Number.isInteger(version) || version < 0) {
    throw { message: 'Order version is required for backend delete', statusCode: 400 };
  }

  return version;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function mapBackendUserToLegacyRow(user: UserDto): AnyObject {
  return {
    id: user.id,
    user_id: user.id,
    username: user.username,
    email: user.email ?? null,
    full_name: user.fullName ?? null,
    role: user.role,
    role_name: USER_ROLE_LABELS[user.role] ?? user.role,
    role_code: user.role,
    employee_id: user.employeeId ?? null,
    is_active: user.isActive,
    permissions: user.permissions,
    last_login_at: null,
    created_at: user.createdAt,
    updated_at: user.updatedAt ?? null,
  };
}

function mapLegacyPaymentCreateVariablesToBackend(variables: AnyObject = {}) {
  return {
    orderId: Number(variables.order_id),
    typePaidId: Number(variables.type_paid_id),
    amount: Number(variables.amount),
    paymentDate: normalizePaymentDate(variables.payment_date),
    notes: normalizeNullableString(variables.notes),
    refKey1c: normalizeNullableString(variables.ref_key_1c),
  };
}

function mapLegacyClientPhoneCreateVariablesToBackend(variables: AnyObject = {}) {
  return {
    clientId: Number(variables.client_id),
    phoneNumber: String(variables.phone_number ?? '').trim(),
    phoneType: variables.phone_type ?? 'mobile',
    isPrimary: variables.is_primary === true,
    refKey1c: normalizeNullableString(variables.ref_key_1c),
  };
}

function mapLegacyClientPhoneUpdateVariablesToBackend(variables: AnyObject = {}) {
  const dto: AnyObject = {};

  if (Object.prototype.hasOwnProperty.call(variables, 'client_id')) {
    dto.clientId = Number(variables.client_id);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'phone_number')) {
    dto.phoneNumber = String(variables.phone_number ?? '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'phone_type')) {
    dto.phoneType = variables.phone_type;
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'is_primary')) {
    dto.isPrimary = variables.is_primary === true;
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'ref_key_1c')) {
    dto.refKey1c = normalizeNullableString(variables.ref_key_1c);
  }

  return dto;
}

function mapBackendClientPhoneToLegacyRow(phone: ClientPhoneDto): AnyObject {
  return {
    phone_id: phone.phoneId,
    client_id: phone.clientId,
    phone_number: phone.phoneNumber,
    phone_type: phone.phoneType,
    is_primary: phone.isPrimary,
    ref_key_1c: phone.refKey1c,
    created_by: phone.createdBy,
    edited_by: phone.editedBy,
    created_at: phone.createdAt,
    updated_at: phone.updatedAt,
  };
}

function mapLegacyPaymentUpdateVariablesToBackend(variables: AnyObject = {}) {
  const dto: AnyObject = {};

  if (Object.prototype.hasOwnProperty.call(variables, 'order_id')) {
    dto.orderId = Number(variables.order_id);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'type_paid_id')) {
    dto.typePaidId = Number(variables.type_paid_id);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'amount')) {
    dto.amount = Number(variables.amount);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'payment_date')) {
    dto.paymentDate = normalizePaymentDate(variables.payment_date);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'notes')) {
    dto.notes = normalizeNullableString(variables.notes);
  }
  if (Object.prototype.hasOwnProperty.call(variables, 'ref_key_1c')) {
    dto.refKey1c = normalizeNullableString(variables.ref_key_1c);
  }

  return dto;
}

function mapBackendPaymentToLegacyRow(payment: PaymentDto): AnyObject {
  return {
    payment_id: payment.paymentId,
    order_id: payment.orderId,
    type_paid_id: payment.typePaidId,
    amount: payment.amount,
    payment_date: payment.paymentDate,
    notes: payment.notes,
    ref_key_1c: payment.refKey1c,
    created_by: payment.createdBy,
    edited_by: payment.editedBy,
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
  };
}

function normalizePaymentDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (value && typeof value === 'object' && 'format' in value) {
    const formatter = (value as { format?: (format: string) => string }).format;
    if (typeof formatter === 'function') {
      return formatter.call(value, 'YYYY-MM-DD');
    }
  }

  const raw = String(value ?? '').trim();
  return raw.includes('T') ? raw.slice(0, 10) : raw;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function parseBooleanFilter(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isUserRole(value: unknown): value is UserRole {
  return (
    value === 'superadmin' ||
    value === 'admin' ||
    value === 'top_manager' ||
    value === 'manager' ||
    value === 'operator' ||
    value === 'worker' ||
    value === 'viewer'
  );
}

const fieldsFor = (resource: string) => {
  const fields = RESOURCE_FIELDS[resource];
  if (!fields) return "";
  return fields.join(" \n");
};

export const dataProvider = (_apiUrl: string) => {
  return {
    getApiUrl: () => HASURA_URL,

    getList: async ({ resource, pagination, sorters, filters }: AnyObject) => {
      const backendOrdersList = await getBackendOrdersListIfEnabled(
        resource,
        pagination,
        sorters,
        filters,
      );
      if (backendOrdersList) {
        return backendOrdersList;
      }

      const backendUsersList = await getBackendUsersListIfEnabled(resource, pagination, filters);
      if (backendUsersList) {
        return backendUsersList;
      }

      // Handle pagination: mode 'off' means no limit/offset
      const paginationMode = pagination?.mode;
      const limit = paginationMode === 'off' ? null : (pagination?.pageSize ?? 10);
      const page = pagination?.current ?? 1;
      const offset = limit !== null ? (page - 1) * limit : 0;

      // Build limit/offset clause for GraphQL
      const limitClause = limit !== null ? `limit: ${limit}, offset: ${offset}` : '';

      const orderBy = buildOrderBy(resource, sorters);

      // Auto-add is_active filter for reference tables (unless explicitly overridden)
      let enhancedFilters = filters || [];
      if (ACTIVE_FILTERED_RESOURCES.includes(resource)) {
        const hasIsActiveFilter = enhancedFilters.some((f: any) => f.field === "is_active");
        if (!hasIsActiveFilter) {
          enhancedFilters = [...enhancedFilters, { field: "is_active", operator: "eq", value: true }];
        }
      }

      // SP3 Task 10b: hide synthetic sheet-shadow materials from user-facing reads
      // (the /materials catalog AND every useSelect({resource:'materials'}) picker),
      // mirroring the is_active pattern. Internal callers may opt in by passing an
      // explicit is_sheet_shadow filter. Save/read/export internals query materials
      // directly by material_id (getOne / filtered IN), not via this default list.
      if (resource === "materials") {
        const hasShadowFilter = enhancedFilters.some((f: any) => f.field === "is_sheet_shadow");
        if (!hasShadowFilter) {
          enhancedFilters = [...enhancedFilters, { field: "is_sheet_shadow", operator: "eq", value: false }];
        }
      }

      const where = buildWhere(enhancedFilters);
      const selection = fieldsFor(resource);
      // For aggregate, remove leading comma from where clause
      const aggregateWhere = where ? `(${where.replace(/^,\s*/, '')})` : '';

      // Build query arguments string
      // limitClause is like "limit: 10, offset: 0" or ""
      // orderBy is like ", order_by: [...]" or ""
      // where is like ", where: {...}" or ""
      const queryArgsStr = limitClause || orderBy || where
        ? `(${limitClause}${orderBy}${where})`
        : '';

      const query = `
        query {
          ${resource}${queryArgsStr} {
            ${selection}
          }
          ${resource}_aggregate${aggregateWhere} { aggregate { count } }
        }
      `;
      const data = await gqlRequest(query);
      return {
        data: data[resource],
        total: data[`${resource}_aggregate`]?.aggregate?.count ?? 0,
      };
    },

    getOne: async ({ resource, id }: AnyObject) => {
      const backendOrder = await getBackendOrderOneIfEnabled(resource, id);
      if (backendOrder) {
        return backendOrder;
      }

      const backendUser = await getBackendUserOneIfEnabled(resource, id);
      if (backendUser) {
        return backendUser;
      }

      const idCol = ID_COLUMNS[resource] ?? "id";
      const selection = fieldsFor(resource);
      const query = `
        query {
          ${resource}(limit: 1, where: { ${idCol}: { _eq: ${escapeValue(id)} } }) {
            ${selection}
          }
        }
      `;
      const data = await gqlRequest(query);
      const record = data[resource]?.[0];
      if (!record) throw { message: "Not found", statusCode: 404 };
      return { data: record };
    },

    create: async ({ resource, variables, meta }: AnyObject) => {
      assertNotBackendOnlyWrite(resource);
      const backendPayment = await createBackendPaymentIfEnabled(resource, variables, meta);
      if (backendPayment) {
        return backendPayment;
      }

      const backendClientPhone = await createBackendClientPhoneIfEnabled(resource, variables);
      if (backendClientPhone) {
        return backendClientPhone;
      }

      if (resource === "orders_view") {
        throw { message: "orders_view is read-only", statusCode: 400 };
      }
      const selection = fieldsFor(resource);
      const idCol = ID_COLUMNS[resource] ?? "id";

      // console.log(`[dataProvider.create] resource: ${resource}, idCol: ${idCol}`);
      // console.log('[dataProvider.create] incoming variables:', variables);

      // Omit PK from insert to let identity/defaults generate value
      const {
        [idCol]: _omitId,
        created_by: _createdBy,
        edited_by: _editedBy,
        created_at: _createdAt,
        updated_at: _updatedAt,
        // SP3 Task 10b: backend-owned control columns must never be set through a
        // legacy Hasura write (sheet write is backend-only, new-only). Stripped here
        // like audit fields — defense-in-depth with the Hasura write-isolation perms.
        sheet_eligible: _sheetEligible,
        sheet_material_type_id: _sheetMaterialTypeId,
        is_sheet_shadow: _isSheetShadow,
        shadow_of_sheet_material_type_id: _shadowOf,
        ...restVars
      } = variables || {};
      // console.log('[dataProvider.create] after omitting PK:', restVars);

      // Sanitize and drop null/undefined to avoid NOT NULL violations on inserts
      const sanitized: AnyObject = sanitizeVariables(restVars);
      // console.log('[dataProvider.create] after sanitize:', sanitized);

      const cleaned: AnyObject = {};
      for (const [k, v] of Object.entries(sanitized)) {
        if (v === null || v === undefined) continue;
        cleaned[k] = v;
      }
      // console.log('[dataProvider.create] after cleaning null/undefined:', cleaned);

      // Validate required fields (simple guard to avoid NOT NULL violations)
      const required = REQUIRED_FIELDS[resource] || [];
      for (const key of required) {
        const val = cleaned[key];
        if (typeof val === "string") {
          if (val.trim().length === 0) {
            throw { message: `Field \"${key}\" is required`, statusCode: 400 };
          }
        }
        if (val === undefined) {
          throw { message: `Field \"${key}\" is required`, statusCode: 400 };
        }
      }

      // Fallback: if PK is required by DB (no default) ensure we send a generated value
      if (FORCE_PK_ON_INSERT[resource]) {
        if (cleaned[idCol] === undefined) {
          // Use epoch ms as BIGINT; unique enough for MVP
          cleaned[idCol] = Date.now();
        }
      }
      const objectLiteral = JSON.stringify(cleaned).replace(/"([^("]+)":/g, "$1:");
      const query = `
        mutation {
          insert_${resource}_one(object: ${objectLiteral}) {
            ${selection}
          }
        }
      `;
      // console.log('[dataProvider.create] GraphQL query:', query);
      const data = await gqlRequest(query);
      return { data: data[`insert_${resource}_one`] };
    },

    update: async ({ resource, id, variables, meta }: AnyObject) => {
      assertNotBackendOnlyWrite(resource);
      const backendPayment = await updateBackendPaymentIfEnabled(resource, id, variables, meta);
      if (backendPayment) {
        return backendPayment;
      }

      const backendClientPhone = await updateBackendClientPhoneIfEnabled(resource, id, variables);
      if (backendClientPhone) {
        return backendClientPhone;
      }

      if (resource === "orders_view") {
        throw { message: "orders_view is read-only", statusCode: 400 };
      }
      const idCol = ID_COLUMNS[resource] ?? "id";
      // Do not send id, audit fields, or timestamps in _set
      // Audit fields (created_by, edited_by) are auto-managed by Hasura permissions via column presets
      const {
        [idCol]: _omit,
        created_by,
        edited_by,
        created_at,
        updated_at,
        // SP3 Task 10b: backend-owned control columns are never set via a legacy
        // Hasura write (sheet write is backend-only). Stripped like audit fields.
        sheet_eligible: _sheetEligibleU,
        sheet_material_type_id: _sheetMaterialTypeIdU,
        is_sheet_shadow: _isSheetShadowU,
        shadow_of_sheet_material_type_id: _shadowOfU,
        ...rest
      } = variables || {};
      const payloadForUpdate = rest;
      const setLiteral = JSON.stringify(sanitizeVariables(payloadForUpdate)).replace(/"([^\(\"]+)":/g, "$1:");
      const query = `
        mutation {
          update_${resource}_by_pk(pk_columns: { ${idCol}: ${escapeValue(id)} }, _set: ${setLiteral}) {
            ${fieldsFor(resource)}
          }
        }
      `;
      const data = await gqlRequest(query);
      return { data: data[`update_${resource}_by_pk`] };
    },

    deleteOne: async ({ resource, id, meta }: AnyObject) => {
      assertNotBackendOnlyWrite(resource);
      const backendOrder = await deleteBackendOrderIfEnabled(resource, id, meta);
      if (backendOrder) {
        return backendOrder;
      }

      const backendPayment = await deleteBackendPaymentIfEnabled(resource, id, meta);
      if (backendPayment) {
        return backendPayment;
      }

      const backendClientPhone = await deleteBackendClientPhoneIfEnabled(resource, id);
      if (backendClientPhone) {
        return backendClientPhone;
      }

      if (resource === "orders_view") {
        throw { message: "orders_view is read-only", statusCode: 400 };
      }
      const idCol = ID_COLUMNS[resource] ?? "id";
      const query = `
        mutation {
          delete_${resource}_by_pk(${idCol}: ${escapeValue(id)}) {
            ${idCol}
          }
        }
      `;
      const data = await gqlRequest(query);
      return { data: data[`delete_${resource}_by_pk`] };
    },

    // Minimal stubs for unused methods in MVP
    getMany: async ({ resource, ids }: AnyObject) => {
      const backendUsers = await getBackendUsersManyIfEnabled(resource, ids);
      if (backendUsers) {
        return backendUsers;
      }

      const idCol = ID_COLUMNS[resource] ?? "id";
      const selection = fieldsFor(resource);
      const query = `
        query {
          ${resource}(where: { ${idCol}: { _in: [${ids.map(escapeValue).join(",")}] } }) {
            ${selection}
          }
        }
      `;
      const data = await gqlRequest(query);
      return { data: data[resource] };
    },

    getManyReference: async (params: AnyObject) => {
      // Fallback to getList logic for MVP
      // @ts-ignore
      return (await (this as any).getList(params));
    },
  } as AnyObject;
};
