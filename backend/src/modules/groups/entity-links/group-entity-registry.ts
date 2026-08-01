import type { PermissionName } from '../../../permissions/permissions';

export interface GroupEntityExistenceQuery {
  text: string;
  values: [string];
}

interface GroupEntityRegistryEntry {
  readonly requiredPermission: PermissionName;
  readonly query: (entityId: string) => GroupEntityExistenceQuery;
}

export const GROUP_ENTITY_REGISTRY = {
  order: {
    requiredPermission: 'orders.view',
    query: (entityId) => ({
      text: `
        SELECT order_id::text AS entity_id, COALESCE(order_name, order_id::text) AS display_label
        FROM public.orders
        WHERE order_id = $1::bigint
          AND order_kind = 'production_order'
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
  user: {
    requiredPermission: 'users.view',
    query: (entityId) => ({
      text: `
        SELECT user_id::text AS entity_id, COALESCE(full_name, username, user_id::text) AS display_label
        FROM public.users
        WHERE user_id = $1::bigint
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
  employee: {
    requiredPermission: 'employees.view',
    query: (entityId) => ({
      text: `
        SELECT employee_id::text AS entity_id, COALESCE(full_name, employee_id::text) AS display_label
        FROM public.employees
        WHERE employee_id = $1::bigint
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
  client: {
    requiredPermission: 'clients.view',
    query: (entityId) => ({
      text: `
        SELECT client_id::text AS entity_id, COALESCE(client_name, client_id::text) AS display_label
        FROM public.clients
        WHERE client_id = $1::bigint
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
  workshop: {
    requiredPermission: 'workshops.view',
    query: (entityId) => ({
      text: `
        SELECT workshop_id::text AS entity_id, COALESCE(workshop_name, workshop_id::text) AS display_label
        FROM public.workshops
        WHERE workshop_id = $1::bigint
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
  deadline_instance: {
    requiredPermission: 'deadlines.view',
    query: (entityId) => ({
      text: `
        SELECT deadline_id::text AS entity_id, deadline_id::text AS display_label
        FROM public.deadline_instances
        WHERE deadline_id = $1::uuid
        FOR KEY SHARE
      `,
      values: [entityId],
    }),
  },
} as const satisfies Record<string, GroupEntityRegistryEntry>;

export type GroupEntityTypeCode = keyof typeof GROUP_ENTITY_REGISTRY;

export const GROUP_ENTITY_TYPE_CODES = Object.keys(GROUP_ENTITY_REGISTRY) as GroupEntityTypeCode[];

export function isGroupEntityTypeCode(value: string): value is GroupEntityTypeCode {
  return Object.hasOwn(GROUP_ENTITY_REGISTRY, value);
}

export function buildGroupEntityExistenceQuery(
  entityType: GroupEntityTypeCode,
  entityId: string | number,
): GroupEntityExistenceQuery {
  return GROUP_ENTITY_REGISTRY[entityType].query(String(entityId));
}
