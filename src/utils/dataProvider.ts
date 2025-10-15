// Minimal Hasura GraphQL data provider for Refine (MVP)
// Implements: getList, getOne, create, update, deleteOne

type AnyObject = Record<string, any>;

const HASURA_URL = (import.meta as any).env.VITE_HASURA_GRAPHQL_URL as string;
const HASURA_ADMIN_SECRET = (import.meta as any).env.VITE_HASURA_ADMIN_SECRET as string;

const ID_COLUMNS: Record<string, string> = {
  orders_view: "order_id",
  orders: "order_id",
  materials: "material_id",
  milling_types: "milling_type_id",
  films: "film_id",
  clients: "client_id",
};

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
    "unit",
    "material_type_id",
    "vendor_id",
    "default_supplier_id",
    "description",
    "ref_key_1c",
  ],
  milling_types: [
    "milling_type_id",
    "milling_type_name",
    "cost_per_sqm",
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
};

const headers = () => ({
  "Content-Type": "application/json",
  "x-hasura-admin-secret": HASURA_ADMIN_SECRET,
});

const gqlRequest = async (query: string): Promise<any> => {
  const res = await fetch(HASURA_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const message = json?.errors?.[0]?.message || res.statusText;
    throw { message, statusCode: res.status };
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
      const where = buildWhere(filters);
      const selection = fieldsFor(resource);
      const query = `
        query {
          ${resource}(limit: ${limit}, offset: ${offset}${orderBy}${where}) {
            ${selection}
          }
          ${resource}_aggregate${where} { aggregate { count } }
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
      const objectLiteral = JSON.stringify(variables).replace(/"([^("]+)":/g, "$1:");
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
      // Do not send id in _set
      const { [idCol]: _omit, ...rest } = variables || {};
      const setLiteral = JSON.stringify(rest).replace(/"([^("]+)":/g, "$1:");
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
