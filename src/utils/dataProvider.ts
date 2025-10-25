// Minimal Hasura GraphQL data provider for Refine (MVP)
// Implements: getList, getOne, create, update, deleteOne

type AnyObject = Record<string, any>;

const HASURA_URL = (import.meta as any).env.VITE_HASURA_GRAPHQL_URL as string;
const HASURA_ADMIN_SECRET = (import.meta as any).env.VITE_HASURA_ADMIN_SECRET as string;

const ID_COLUMNS: Record<string, string> = {
  orders_view: "order_id",
  orders: "order_id",
  materials: "material_id",
  material_types: "material_type_id",
  vendors: "vendor_id",
  suppliers: "supplier_id",
  milling_types: "milling_type_id",
  films: "film_id",
  clients: "client_id",
  film_types: "film_type_id",
  film_vendors: "film_vendor_id",
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
  resource_requirements_statuses: "requirement_status_id",
  order_workshops: "order_workshop_id",
  order_resource_requirements: "requirement_id",
};

// Resources with is_active field - automatically filter by is_active = true in getList
const ACTIVE_FILTERED_RESOURCES = [
  // Reference tables (справочники)
  // NOTE: "units" does NOT have is_active field in schema v11.5
  "clients",
  "edge_types",
  "film_vendors",
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
];

const RESOURCE_FIELDS: Record<string, string[]> = {
  // Read-only aggregate view
  orders_view: [
    "order_id",
    "order_name",
    "order_date",
    "client_name",
    "milling_type_name",
    "material_name",
    "film_name",
    "priority",
    "completion_date",
    "planned_completion_date",
    "order_status_name",
    "payment_status_name",
    "issue_date",
    "total_amount",
    "discounted_amount",
    "discount",
    "paid_amount",
    "payment_date",
    "parts_count",
    "total_area",
    "edge_type_name",
  ],
  // Base orders table (for edit)
  orders: [
    "order_id",
    "order_number",
    "order_date",
    "client_id",
    "material_id",
    "milling_type_id",
    "film_id",
    "price",
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
  ],
  material_types: [
    "material_type_id",
    "material_type_name",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  
  milling_types: [
    "milling_type_id",
    "milling_type_name",
    "cost_per_sqm",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  films: [
    "film_id",
    "film_name",
    "film_type_id",
    "film_vendor_id",
    "film_texture",
    "ref_key_1c",
  ],
  clients: [
    "client_id",
    "client_name",
    "ref_key_1c",
  ],
  film_types: [
    "film_type_id",
    "film_type_name",
    "ref_key_1c",
  ],
  film_vendors: [
    "film_vendor_id",
    "film_vendor_name",
    "ref_key_1c",
  ],
  edge_types: [
    "edge_type_id",
    "edge_type_name",
    "sort_order",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  vendors: [
    "vendor_id",
    "vendor_name",
    "contact_info",
    "ref_key_1c",
  ],
  suppliers: [
    "supplier_id",
    "supplier_name",
    "address",
    "contact_person",
    "phone",
    "ref_key_1c",
  ],
  order_statuses: [
    "order_status_id",
    "order_status_name",
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  payment_statuses: [
    "payment_status_id",
    "payment_status_name",
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
  ],
  payment_types: [
    "type_paid_id",
    "type_paid_name",
    "sort_order",
    "is_active",
    "ref_key_1c",
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
    "sort_order",
    "color",
    "description",
    "is_active",
    "ref_key_1c",
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
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  film_vendors: ["film_vendor_name"],
  film_types: ["film_type_name"],
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

const headers = () => ({
  "Content-Type": "application/json",
  "x-hasura-admin-secret": HASURA_ADMIN_SECRET,
});

// Helper to parse PostgreSQL error messages into user-friendly text
const parsePostgresError = (message: string): string => {
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
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const rawMessage = json?.errors?.[0]?.message || res.statusText;
    const message = parsePostgresError(rawMessage);
    const statusCode = !res.ok ? res.status : 400;
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
  // Fields that should stay as strings even if they look like numbers
  const stringFields = ["password_hash", "ref_key_1c"];

  for (const [k, v] of Object.entries(input || {})) {
    if (v === "") {
      out[k] = null;
      continue;
    }
    // Don't convert password_hash or other string fields to numbers
    if (typeof v === "string" && /^\d+$/.test(v) && !stringFields.includes(k)) {
      out[k] = Number(v);
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

const fieldsFor = (resource: string) => {
  const fields = RESOURCE_FIELDS[resource];
  if (!fields) return "";
  return fields.join(" \n");
};

export const dataProvider = (_apiUrl: string) => {
  return {
    getApiUrl: () => HASURA_URL,

    getList: async ({ resource, pagination, sorters, filters }: AnyObject) => {
      const limit = pagination?.pageSize ?? 10;
      const page = pagination?.current ?? 1;
      const offset = (page - 1) * limit;
      const orderBy = buildOrderBy(resource, sorters);

      // Auto-add is_active filter for reference tables (unless explicitly overridden)
      let enhancedFilters = filters || [];
      if (ACTIVE_FILTERED_RESOURCES.includes(resource)) {
        const hasIsActiveFilter = enhancedFilters.some((f: any) => f.field === "is_active");
        if (!hasIsActiveFilter) {
          enhancedFilters = [...enhancedFilters, { field: "is_active", operator: "eq", value: true }];
        }
      }

      const where = buildWhere(enhancedFilters);
      const selection = fieldsFor(resource);
      // For aggregate, remove leading comma from where clause
      const aggregateWhere = where ? `(${where.replace(/^,\s*/, '')})` : '';
      const query = `
        query {
          ${resource}(limit: ${limit}, offset: ${offset}${orderBy}${where}) {
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

    create: async ({ resource, variables }: AnyObject) => {
      if (resource === "orders_view") {
        throw { message: "orders_view is read-only", statusCode: 400 };
      }
      const selection = fieldsFor(resource);
      const idCol = ID_COLUMNS[resource] ?? "id";
      // Omit PK from insert to let identity/defaults generate value
      const { [idCol]: _omitId, ...restVars } = variables || {};
      // Sanitize and drop null/undefined to avoid NOT NULL violations on inserts
      const sanitized: AnyObject = sanitizeVariables(restVars);
      const cleaned: AnyObject = {};
      for (const [k, v] of Object.entries(sanitized)) {
        if (v === null || v === undefined) continue;
        cleaned[k] = v;
      }
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
      const data = await gqlRequest(query);
      return { data: data[`insert_${resource}_one`] };
    },

    update: async ({ resource, id, variables }: AnyObject) => {
      if (resource === "orders_view") {
        throw { message: "orders_view is read-only", statusCode: 400 };
      }
      const idCol = ID_COLUMNS[resource] ?? "id";
      // Do not send id, audit fields, or timestamps in _set
      const {
        [idCol]: _omit,
        created_by,
        edited_by,
        created_at,
        updated_at,
        ...rest
      } = variables || {};
      const setLiteral = JSON.stringify(sanitizeVariables(rest)).replace(/"([^(\"]+)":/g, "$1:");
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

    deleteOne: async ({ resource, id }: AnyObject) => {
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
