import type { PermissionName } from '../api/types/authApi.types';

/**
 * Access groups (plan v6 §6): a group never creates Hasura permissions — the Hasura role stays the base role, and the
 * effective-permission predicates only filter what that role may already do. For every permission that a Hasura rule
 * requires (ops/hasura/access-predicates.json) this map lists the Hasura operations it opens and the Hasura roles that
 * have them (ops/hasura/metadata.json). Generated; `hasuraPermissionReach.test.ts` keeps it equal to the metadata.
 * Permissions checked only by the backend are absent: they work for every role.
 */
export const HASURA_PERMISSION_REACH: Readonly<Partial<Record<PermissionName, Readonly<Record<string, readonly string[]>>>>> = {
  'clients.analytics.view': {
    'clients_analytics_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'clients.create': {
    'clients.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'clients.delete': {
    'clients.delete': ['erp_admin', 'manager', 'operator', 'superadmin'],
  },
  'clients.update': {
    'clients.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'clients.view': {
    'client_phones.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'clients.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'clients_analytics_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'doweling.view': {
    'doweling_orders.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'doweling_orders_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'employees.manage': {
    'employees.delete': ['erp_admin', 'manager', 'superadmin'],
    'employees.insert': ['erp_admin', 'manager', 'superadmin', 'top_manager'],
    'employees.update': ['erp_admin', 'manager', 'superadmin'],
  },
  'employees.view': {
    'employees.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'finance.analytics.view': {
    'payments_view.select': ['erp_admin'],
  },
  'materials.manage': {
    'materials.delete': ['erp_admin', 'manager', 'superadmin'],
    'materials.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'materials.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'materials.view': {
    'materials.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
  },
  'notifications.view_rules': {
    'roles.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'orders.view': {
    'clients_analytics_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'order_details.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'order_details_view.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'order_doweling_links.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'order_statuses.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer'],
    'orders.select': ['erp_admin'],
    'orders_view.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'production_status_events.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'production_statuses.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
  },
  'orders.view_financials': {
    'clients_analytics_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'order_resource_requirements.select': ['erp_admin'],
    'orders.select': ['erp_admin'],
    'payments.select': ['erp_admin'],
    'payments_view.select': ['erp_admin'],
  },
  'payments.view': {
    'clients_analytics_view.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'payments.select': ['erp_admin'],
    'payments_view.select': ['erp_admin'],
  },
  'production.view': {
    'order_workshops.select': ['erp_admin'],
  },
  'references.manage': {
    'edge_types.delete': ['erp_admin', 'manager', 'superadmin'],
    'edge_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'edge_types.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'film_types.delete': ['erp_admin', 'manager', 'operator', 'superadmin'],
    'film_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin'],
    'film_types.update': ['erp_admin', 'manager', 'operator', 'superadmin'],
    'films.delete': ['erp_admin', 'manager', 'superadmin'],
    'films.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'films.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'material_transaction_types.delete': ['erp_admin', 'superadmin'],
    'material_transaction_types.insert': ['erp_admin', 'superadmin'],
    'material_transaction_types.update': ['erp_admin', 'superadmin'],
    'material_types.delete': ['erp_admin', 'manager', 'operator', 'superadmin'],
    'material_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'material_types.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'milling_types.delete': ['erp_admin', 'manager', 'superadmin'],
    'milling_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'milling_types.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'movements_statuses.delete': ['erp_admin', 'superadmin'],
    'movements_statuses.insert': ['erp_admin', 'superadmin'],
    'movements_statuses.update': ['erp_admin', 'superadmin'],
    'order_statuses.delete': ['erp_admin', 'superadmin'],
    'order_statuses.insert': ['erp_admin', 'superadmin'],
    'order_statuses.update': ['erp_admin', 'superadmin'],
    'payment_statuses.delete': ['erp_admin', 'superadmin'],
    'payment_statuses.insert': ['erp_admin', 'superadmin'],
    'payment_statuses.update': ['erp_admin', 'superadmin'],
    'payment_types.delete': ['erp_admin', 'manager', 'superadmin'],
    'payment_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'payment_types.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'production_statuses.delete': ['erp_admin', 'superadmin'],
    'production_statuses.insert': ['erp_admin', 'superadmin'],
    'production_statuses.update': ['erp_admin', 'superadmin'],
    'requisition_statuses.delete': ['erp_admin', 'manager', 'superadmin'],
    'requisition_statuses.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'requisition_statuses.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'resource_requirements_statuses.delete': ['erp_admin', 'manager', 'superadmin'],
    'resource_requirements_statuses.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'resource_requirements_statuses.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'transaction_direction.delete': ['erp_admin', 'superadmin'],
    'transaction_direction.insert': ['erp_admin', 'superadmin'],
    'transaction_direction.update': ['erp_admin', 'superadmin'],
    'units.delete': ['erp_admin', 'superadmin'],
    'units.insert': ['erp_admin', 'superadmin'],
    'units.update': ['erp_admin', 'superadmin'],
  },
  'references.quick_create': {
    'edge_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'films.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'milling_types.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'references.view': {
    'edge_types.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'film_types.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'films.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'material_transaction_types.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'material_types.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'milling_types.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'movements_statuses.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'order_statuses.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer'],
    'payment_statuses.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'payment_types.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'production_statuses.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'requisition_statuses.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'resource_requirements_statuses.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'sheet_material_types.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
    'transaction_direction.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'units.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'requirements.view': {
    'order_resource_requirements.select': ['erp_admin'],
  },
  'settings.manage': {
    'app_settings.delete': ['erp_admin', 'manager', 'superadmin'],
    'app_settings.insert': ['erp_admin', 'manager', 'superadmin', 'top_manager'],
    'app_settings.update': ['erp_admin', 'manager', 'superadmin', 'top_manager'],
  },
  'settings.view': {
    'roles.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'sheet_materials.view': {
    'sheet_material_types.select': ['erp_admin', 'manager', 'operator', 'packer', 'superadmin', 'top_manager', 'viewer', 'worker'],
  },
  'suppliers.manage': {
    'suppliers.delete': ['erp_admin', 'manager', 'superadmin'],
    'suppliers.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'suppliers.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'suppliers.view': {
    'suppliers.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'users.view': {
    'roles.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
    'users.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'vendors.manage': {
    'vendors.delete': ['erp_admin', 'manager', 'superadmin'],
    'vendors.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'vendors.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'vendors.view': {
    'vendors.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'vlm.configure': {
    'vlm_prompts.delete': ['erp_admin', 'superadmin'],
    'vlm_prompts.insert': ['erp_admin', 'superadmin', 'top_manager'],
    'vlm_prompts.update': ['erp_admin', 'superadmin', 'top_manager'],
    'vlm_provider_models.delete': ['erp_admin', 'superadmin'],
    'vlm_provider_models.insert': ['erp_admin', 'superadmin', 'top_manager'],
    'vlm_provider_models.update': ['erp_admin', 'superadmin', 'top_manager'],
    'vlm_providers.delete': ['erp_admin', 'superadmin'],
    'vlm_providers.insert': ['erp_admin', 'superadmin', 'top_manager'],
    'vlm_providers.update': ['erp_admin', 'superadmin', 'top_manager'],
  },
  'vlm.use': {
    'vlm_prompts.select': ['erp_admin', 'manager', 'superadmin', 'top_manager', 'viewer'],
    'vlm_provider_models.select': ['erp_admin', 'manager', 'superadmin', 'top_manager', 'viewer'],
    'vlm_providers.select': ['erp_admin', 'manager', 'superadmin', 'top_manager', 'viewer'],
  },
  'work_centers.manage': {
    'work_centers.delete': ['erp_admin', 'manager', 'superadmin'],
    'work_centers.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'work_centers.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'work_centers.view': {
    'work_centers.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
  'workshops.manage': {
    'workshops.delete': ['erp_admin', 'manager', 'superadmin'],
    'workshops.insert': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
    'workshops.update': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager'],
  },
  'workshops.view': {
    'workshops.select': ['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer'],
  },
};

/** Hasura role of an ERP role in the access token (backend hasuraRoleForErpRole). */
export function hasuraRoleForErpRole(role: string): string {
  return role === 'admin' ? 'erp_admin' : role;
}

export interface HasuraReachGap {
  permission: string;
  /** `table.operation` that the permission opens but the role's Hasura profile does not have. */
  targets: string[];
}

/** Permissions of `permissions` that cannot work in Hasura for a user with the base role `roleCode`. */
export function hasuraReachGaps(permissions: readonly string[], roleCode: string | null | undefined): HasuraReachGap[] {
  const hasuraRole = hasuraRoleForErpRole(roleCode ?? '');
  const gaps: HasuraReachGap[] = [];
  for (const permission of permissions) {
    const reach = HASURA_PERMISSION_REACH[permission as PermissionName];
    if (!reach) continue;
    const targets = Object.entries(reach).filter(([, roles]) => !roles.includes(hasuraRole)).map(([target]) => target);
    if (targets.length > 0) gaps.push({ permission, targets });
  }
  return gaps;
}
